import * as vscode from 'vscode';
import { Renderer, FileContentInfo } from './renderer';

enum UpdateMode {
    Live = 'live',
    Sticky = 'sticky',
}

export class DefViewViewProvider implements vscode.WebviewViewProvider {
    // Add a new property to cache the last content
    private _lastContent?: {
        content: string;
        startLine: number;
        updateMode: UpdateMode;
    };

    //private static readonly outputChannel = vscode.window.createOutputChannel('Definition View');

    private currentUri: vscode.Uri | undefined = undefined;
    private currentLine: number = 0; // 添加行号存储
    public static readonly viewType = 'defView.definition';

    private static readonly pinnedContext = 'defView.definitionView.isPinned';

    private readonly _disposables: vscode.Disposable[] = [];

    private readonly _renderer = new Renderer();

    private _view?: vscode.WebviewView;
    private _currentCacheKey: CacheKey = cacheKeyNone;
    private _loading?: { cts: vscode.CancellationTokenSource }

    private _updateMode = UpdateMode.Live;
    private _pinned = false;
    private _currentPanel?: vscode.WebviewPanel; // 添加成员变量存储当前面板
    private _pickItems: any[] | undefined; // 添加成员变量存储选择项

    constructor(
        private readonly _extensionUri: vscode.Uri,
    ) {
        // Listens for changes to workspace folders (when user adds/removes folders)
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            if (this._currentPanel) {
                //DefViewViewProvider.outputChannel.appendLine('[definition] onDidChangeWorkspaceFolders dispose');
                this._currentPanel.dispose();
                this._currentPanel = undefined;
            }
        }, null, this._disposables);

        // 失去焦点时
        vscode.window.onDidChangeWindowState((e) => {
            if (!e.focused && this._currentPanel) {
                //DefViewViewProvider.outputChannel.appendLine('[definition] onDidChangeWindowState dispose');
                this._currentPanel.dispose();
                this._currentPanel = undefined;
            }
        }, null, this._disposables);

        // when the extension is deactivated，clean up resources
        this._disposables.push(
            vscode.Disposable.from({
                dispose: () => {
                    if (this._currentPanel) {
                        //DefViewViewProvider.outputChannel.appendLine('[definition] dispose');
                        this._currentPanel.dispose();
                        this._currentPanel = undefined;
                    }
                }
            })
        );

        // 修改选择变化事件处理
        vscode.window.onDidChangeTextEditorSelection((e) => {
            // 只有当用户主动改变位置时才触发更新，且不在文本选择状态下
            if ((e.kind === vscode.TextEditorSelectionChangeKind.Mouse || 
                e.kind === vscode.TextEditorSelectionChangeKind.Keyboard) && e.selections[0].isEmpty) {
                //console.log('[definition] vscode.window.onDidChangeTextEditorSelection');
                this.update();
            }
        }, null, this._disposables);

        this._renderer.needsRender(() => {
            this.update(/* force */ true);
        }, undefined, this._disposables);

        // Listens for VS Code settings changes
        vscode.workspace.onDidChangeConfiguration(() => {
            this.updateConfiguration();
        }, null, this._disposables);

        this.updateConfiguration();
        //this.update(); // 此时view还未创建，无法更新

        // Add delayed initial update，保底更新
        setTimeout(() => {
            //console.log('[definition] timeout update');
            this.update(/* force */ true);
        }, 2000); // Wait for 2 seconds after initialization

        // listen for language status changes
        vscode.languages.onDidChangeDiagnostics(e => {
            const editor = vscode.window.activeTextEditor;
            if (editor && e.uris.some(uri => uri.toString() === editor.document.uri.toString())) {
                //console.log('[definition] Document diagnostics updated, updating definitions');
                this.update(/* force */ true);
            }
        }, null, this._disposables);
    }

    dispose() {
        //DefViewViewProvider.outputChannel.appendLine('[definition] Provider disposing...');
        // 确保关闭定义选择面板
        if (this._currentPanel) {
            this._currentPanel.dispose();
            this._currentPanel = undefined;
        }

        // 清理其他资源
        let item: vscode.Disposable | undefined;
        while ((item = this._disposables.pop())) {
            item.dispose();
        }

        //DefViewViewProvider.outputChannel.dispose();
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._extensionUri, 'media')
            ]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // 添加webview消息处理
        webviewView.webview.onDidReceiveMessage(async message => {
            switch (message.type) {
                case 'lineDoubleClick':
                case 'areaDoubleClick':
                    // 处理双击跳转
                    try {
                        if (!this.currentUri)
                            throw new Error('No definition URI available');
                        // 打开文件
                        const document = await vscode.workspace.openTextDocument(this.currentUri);
                        const editor = await vscode.window.showTextDocument(document);
                        
                        // 跳转到指定行
                        const line = this.currentLine;//message.line - 1; // VSCode的行号从0开始
                        const range = new vscode.Range(line, 0, line, 0);
                        
                        // 移动光标并显示该行
                        editor.selection = new vscode.Selection(range.start, range.start);
                        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
                    } catch (error) {
                        vscode.window.showErrorMessage(`Failed to open file: ${error}`);
                    }
                    break;
            }
        });

        webviewView.onDidChangeVisibility(() => {
            if (this._view?.visible) {
                //console.log('[definition] onDidChangeVisibility');
                // If we have cached content, restore it immediately
                if (this._lastContent) {
                    // Show loading
                    this._view?.webview.postMessage({ type: 'startLoading' });
                    this._view.webview.postMessage({
                        type: 'update',
                        body: this._lastContent.content,
                        updateMode: this._lastContent.updateMode,
                        scrollToLine: this._lastContent.startLine + 1
                    });
                    // Hide loading after content is updated
                    //this._view?.webview.postMessage({ type: 'endLoading' });
                }
                else
                    this.update(/* force */ true);
            } else {
                if (this._currentPanel) {
                    this._currentPanel.dispose();
                    this._currentPanel = undefined;
                }
            }
        });

        webviewView.onDidDispose(() => {
            this._view = undefined;
        });

        this.updateTitle();

        // 初始加载时如果有缓存内容就直接使用
        if (this._lastContent) {
            //console.log('[definition] Using cached content for initial load');
            // Show loading
            this._view?.webview.postMessage({ type: 'startLoading' });
            this._view.webview.postMessage({
                type: 'update',
                body: this._lastContent.content,
                updateMode: this._lastContent.updateMode,
                scrollToLine: this._lastContent.startLine + 1
            });
            // Hide loading after content is updated
            //this._view?.webview.postMessage({ type: 'endLoading' });
        } else {
            //console.log('[definition] resolveWebviewView to update');
            // 没有缓存才触发更新
            this.update(/* force */ true);
        }
    }

    public pin() {
        this.updatePinned(true);
    }

    public unpin() {
        this.updatePinned(false);
    }

    private updatePinned(value: boolean) {
        if (this._pinned === value) {
            return;
        }

        this._pinned = value;
        vscode.commands.executeCommand('setContext', DefViewViewProvider.pinnedContext, value);

        this.update();
    }

    private updateTitle() {
        if (!this._view) {
            return;
        }
        this._view.description = this._pinned ? "(pinned)" : undefined;
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.css'));

        const nonce = getNonce();

        return /* html */`<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">

                <meta http-equiv="Content-Security-Policy" content="
                    default-src 'none';
                    style-src ${webview.cspSource} 'unsafe-inline';
                    script-src 'nonce-${nonce}';
                    img-src data: https:;
                    ">

                <meta name="viewport" content="width=device-width, initial-scale=1.0">

                <style>
                    .loading {
                        position: fixed;
                        top: 0;
                        left: 0;
                        right: 0;
                        bottom: 0;
                        background: rgba(0, 0, 0, 0.08);
                        display: none;
                        justify-content: center;
                        align-items: center;
                        z-index: 1000;
                        opacity: 0;
                        transition: opacity 0.2s ease-in-out;
                    }
                    .loading.active {
                        display: flex;
                    }
                    .loading.show {
                        opacity: 1;
                    }
                    .loading::after {
                        content: '';
                        width: 20px;
                        height: 20px;
                        border: 2px solid #0078d4;
                        border-radius: 50%;
                        border-top-color: transparent;
                        animation: spin 1s linear infinite;
                    }
                    @keyframes spin {
                        to { transform: rotate(360deg); }
                    }
                </style>

                <link href="${styleUri}" rel="stylesheet">
                
                <title>Definition View</title>
            </head>
            <body>
                <div class="loading"></div>
                <article id="main"></article>
                <script nonce="${nonce}" src="${scriptUri}"></script>
            </body>
            </html>`;
    }

    private async update(ignoreCache = false) {
        if (!this._view?.visible) {
            //console.log('[definition] update no view');
            return;
        }

        this.updateTitle();

        if (this._pinned) {
            //console.log('[definition] update pinned');
            return;
        }

        const newCacheKey = createCacheKey(vscode.window.activeTextEditor);
        if (/*!ignoreCache && */cacheKeyEquals(this._currentCacheKey, newCacheKey)) {
            //console.log('[definition] the same cache key');
            return;
        }

        if (this._loading) {
            this._loading.cts.cancel();
            this._loading = undefined;
        }

        // 检查是否有有效的选择
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            //console.log('[definition] update no editor');
            return;
        }

        const loadingEntry = { cts: new vscode.CancellationTokenSource() };
        this._loading = loadingEntry;

        const updatePromise = (async () => {
            const contentInfo = await this.getHtmlContentForActiveEditor(loadingEntry.cts.token);
            if (loadingEntry.cts.token.isCancellationRequested) {
                return;
            }

            if (this._loading !== loadingEntry) {
                // A new entry has started loading since we started
                return;
            }
            this._loading = undefined;
            this._currentCacheKey = newCacheKey;

            if (contentInfo.jmpUri) {
                this.currentUri = contentInfo.jmpUri;
                this.currentLine = contentInfo.startLine;
            }

            if (contentInfo.content.length) {
                // Cache the content before sending
                this._lastContent = {
                    content: contentInfo.content,
                    startLine: contentInfo.startLine,
                    updateMode: this._updateMode
                };

                // Show loading
                this._view?.webview.postMessage({ type: 'startLoading' });

                this._view?.webview.postMessage({
                    type: 'update',
                    body: contentInfo.content,
                    updateMode: this._updateMode,
                    scrollToLine: contentInfo.startLine + 1
                });

                // Hide loading after content is updated
                //this._view?.webview.postMessage({ type: 'endLoading' });
            } else {
                this._lastContent = undefined;
                this._view?.webview.postMessage({
                    type: 'noContent',
                    body: '&nbsp;&nbsp;No symbol found at current cursor position',
                    updateMode: this._updateMode,
                });
            }
        })();

        await Promise.race([
            updatePromise,

            // Don't show progress indicator right away, which causes a flash
            new Promise<void>(resolve => setTimeout(resolve, 250)).then(() => {
                if (loadingEntry.cts.token.isCancellationRequested) {
                    return;
                }
                return vscode.window.withProgress({ location: { viewId: DefViewViewProvider.viewType } }, () => updatePromise);
            }),
        ]);
    }

    // 修改选择事件处理方法
    private async getHtmlContentForActiveEditor(token: vscode.CancellationToken): Promise<FileContentInfo> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            //console.log('No editor');
            return { content: '', startLine: 0, endLine: 0, jmpUri: undefined };
        }

        // 获取当前光标位置
        const position = editor.selection.active;
        
        // 获取当前光标位置下的单词或标识符的范围
        const wordRange = editor.document.getWordRangeAtPosition(position);

        // 获取该范围内的文本内容
        const selectedText = wordRange ? editor.document.getText(wordRange) : '';
        //vscode.window.showInformationMessage(`Selected text: ${selectedText}`);

        let definitions = await this.getDefinitionAtCurrentPositionInEditor(editor);

        if (token.isCancellationRequested || !definitions || definitions.length === 0) {
            //console.log('[definition] No definitions found');
            return { content: '', startLine: 0, endLine: 0, jmpUri: undefined };
        }

        // 确保关闭之前的面板
        if (this._currentPanel) {
            this._currentPanel.dispose();
            this._currentPanel = undefined;
        }

        if (definitions.length > 1) {
            const selectedDefinition = await this.showDefinitionPicker(definitions, editor);
            if (!selectedDefinition) {
                return { content: '', startLine: 0, endLine: 0, jmpUri: undefined };
            }
            definitions = [selectedDefinition];
        }
        //console.log(definitions);
        return definitions.length ? await this._renderer.renderDefinitions(editor.document, definitions, selectedText) : {
            content: '',
            startLine: 0,
            endLine: 0,
            jmpUri: undefined
        };
    }

    private async getDefinitionAtCurrentPositionInEditor(editor: vscode.TextEditor) {
        return await vscode.commands.executeCommand<vscode.Location[]>(
           'vscode.executeDefinitionProvider',
           editor.document.uri,
           editor.selection.active
        );
    }

    private updateConfiguration() {
        const config = vscode.workspace.getConfiguration('defView');
        this._updateMode = config.get<UpdateMode>('definitionView.updateMode') || UpdateMode.Live;
    }

    private async showDefinitionPicker(definitions: any[], editor: vscode.TextEditor): Promise<any> {
        return new Promise<any>((resolve) => {
            this._currentPanel = vscode.window.createWebviewPanel(
                'definitionPicker',
                'Select a Definition',
                vscode.ViewColumn.Beside,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true
                }
            );

            const panel = this._currentPanel;
            let isResolved = false;

            // 先设置事件监听
            panel.webview.onDidReceiveMessage(async message => {
                if (message.command === 'selectDefinition' && !isResolved) {
                    const selected = this._pickItems?.find(item => item.label === message.label);
                    if (selected) {
                        isResolved = true;
                        this._currentPanel = undefined;
                        panel.dispose();
                        resolve(selected.definition);
                    }
                }
            });

            panel.onDidDispose(() => {
                this._pickItems = undefined; // Clear stored items
                if (!isResolved) {
                    isResolved = true;
                    this._currentPanel = undefined;
                    resolve(undefined);
                }
            });

            //console.log(`[definition] Showing definition picker with ${definitions.length} definitions`);
            //DefViewViewProvider.outputChannel.appendLine(`[definition] Showing definition picker with ${definitions.length} definitions`);

            // 然后准备并设置内容
            Promise.all(definitions.map(async (definition, index) => {
                try {
                    let def = definition;
                    let uri = (def instanceof vscode.Location) ? def.uri : def.targetUri;
                    let range = (def instanceof vscode.Location) ? def.range : def.targetRange;
    
                    const document = await vscode.workspace.openTextDocument(uri);
                    if (!document) {
                        //DefViewViewProvider.outputChannel.appendLine(`Could not open document: ${uri.toString()}`);
                        return null;
                    }
    
                    const startLine = Math.max(range.start.line - 3, 0);
                    const endLine = Math.min(range.end.line + 3, document.lineCount - 1);
                    
                    const codeLines = [];
                    for (let i = startLine; i <= endLine; i++) {
                        const line = document.lineAt(i).text;
                        if (i >= range.start.line && i <= range.end.line) {
                            codeLines.push(`<mark>${line}</mark>`);
                        } else {
                            codeLines.push(line);
                        }
                    }
                    // 留点空白
                    const codeSnippet = codeLines.join('        \n');
    
                    return {
                        label: `Definition ${index + 1}: ${uri.fsPath}`,
                        description: `Line: ${range.start.line + 1}, Column: ${range.start.character + 1}`,
                        detail: codeSnippet,
                        definition
                    };
                } catch (error) {
                    //DefViewViewProvider.outputChannel.appendLine(`Error processing definition: ${error}`);
                    return null;
                }
            })).then(items => {
                // Filter out any null items from errors
                const validItems = items.filter(item => item !== null);
                if (validItems.length === 0) {
                    //console.error('No valid definitions found');
                    panel.dispose();
                    resolve(undefined);
                    return;
                }
    
                this._pickItems = validItems;
                panel.webview.html = this.getDefinitionSelectorWebviewContent(validItems);
            }).catch(error => {
                //console.error('Error preparing definitions:', error);
                panel.dispose();
                resolve(undefined);
            });
        });
    }

    private getDefinitionSelectorWebviewContent(items: any[]): string {
        const itemsHtml = items.map(item => `
            <div class="item" ondblclick="selectDefinition('${item.label}')">
                <div class="header">
                    <strong>${item.label}</strong>
                    <p>${item.description}</p>
                </div>
                <div class="code-container">
                    <pre><code>${item.detail}</code></pre>
                </div>
            </div>
        `).join('');

        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style>
                    body { 
                        font-family: Arial, sans-serif; 
                        margin: 0;
                        padding: 0;
                        max-height: 100vh;
                        overflow-y: auto;
                        overflow-x: hidden;
                    }
                    .item { 
                        padding: 10px; 
                        border-bottom: 1px solid #ccc; 
                        cursor: pointer;
                    }
                    .item:hover { 
                        background-color:rgba(0, 120, 212, 0.27);
                    }
                    .header {
                        margin-bottom: 8px;
                    }
                    .code-container {
                        position: relative;
                        width: 100%;
                        overflow-x: auto;
                        background-color: #fafafa;
                        border-radius: 4px;
                        padding: 8px;  // Add horizontal padding to container
                    }
                    pre { 
                        margin: 0;
                        white-space: pre !important;
                        word-wrap: normal !important;
                        padding: 8px 24px;
                        background: transparent;
                        display: inline-block;
                        min-width: fit-content;
                    }
                    code {
                        white-space: pre !important;
                        word-wrap: normal !important;
                        display: inline-block;
                        font-family: var(--vscode-editor-font-family);
                        width: max-content;
                    }
                    mark {
                        background-color: #ffe58f;
                        padding: 2px 0;
                    }
                </style>
            </head>
            <body>
                ${itemsHtml}
                <script>
                    const vscode = acquireVsCodeApi();
                    let mouseDownTarget = null;
                let mouseDownPosition = null;

                function selectDefinition(label) {
                    vscode.postMessage({ command: 'selectDefinition', label });
                }

                // Handle mouse events on items
                document.querySelectorAll('.item').forEach(item => {
                    // Remove the ondblclick attribute from HTML
                    item.removeAttribute('ondblclick');
                    
                    // Track mouse down position
                    item.addEventListener('mousedown', (e) => {
                        mouseDownTarget = e.target;
                        mouseDownPosition = { x: e.clientX, y: e.clientY };
                    });

                    // Check on mouse up if we should trigger the click
                    item.addEventListener('mouseup', (e) => {
                        if (mouseDownTarget && mouseDownPosition) {
                            // Check if mouse moved significantly
                            const moveThreshold = 5; // pixels
                            const xDiff = Math.abs(e.clientX - mouseDownPosition.x);
                            const yDiff = Math.abs(e.clientY - mouseDownPosition.y);
                            
                            if (xDiff <= moveThreshold && yDiff <= moveThreshold) {
                                const label = item.querySelector('strong').textContent;
                                selectDefinition(label);
                            }
                        }
                        // Reset tracking variables
                        mouseDownTarget = null;
                        mouseDownPosition = null;
                    });
                });

                // Reset tracking variables if mouse leaves the item
                document.addEventListener('mouseleave', () => {
                    mouseDownTarget = null;
                    mouseDownPosition = null;
                });
                </script>
            </body>
            </html>
        `;
    }
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

type CacheKey = typeof cacheKeyNone | DocumentCacheKey;

const cacheKeyNone = { type: 'none' } as const;

class DocumentCacheKey {
    readonly type = 'document';

    constructor(
        public readonly url: vscode.Uri,
        public readonly version: number,
        public readonly wordRange: vscode.Range | undefined,
    ) { }

    public equals(other: DocumentCacheKey): boolean {
        if (this.url.toString() !== other.url.toString()) {
            return false;
        }

        if (this.version !== other.version) {
            return false;
        }

        if (other.wordRange === this.wordRange) {
            return true;
        }

        if (!other.wordRange || !this.wordRange) {
            return false;
        }

        return this.wordRange.isEqual(other.wordRange);
    }
}

function cacheKeyEquals(a: CacheKey, b: CacheKey): boolean {
    if (a === b) {
        return true;
    }

    if (a.type !== b.type) {
        return false;
    }

    if (a.type === 'none' || b.type === 'none') {
        return false;
    }

    return a.equals(b);
}

function createCacheKey(editor: vscode.TextEditor | undefined): CacheKey {
    if (!editor) {
        return cacheKeyNone;
    }

    return new DocumentCacheKey(
        editor.document.uri,
        editor.document.version,
        editor.document.getWordRangeAtPosition(editor.selection.active));
}
