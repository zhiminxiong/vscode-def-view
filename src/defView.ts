import * as vscode from 'vscode';
import { Renderer, FileContentInfo } from './renderer';

enum UpdateMode {
	Live = 'live',
	Sticky = 'sticky',
}

export class DefViewViewProvider implements vscode.WebviewViewProvider {
    private currentFilePath: string = ''; // 添加成员变量存储当前文件路径
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

	constructor(
		private readonly _extensionUri: vscode.Uri,
	) {
		vscode.window.onDidChangeActiveTextEditor(() => {
			this.update();
		}, null, this._disposables);

		vscode.window.onDidChangeTextEditorSelection(() => {
			this.update();
		}, null, this._disposables);

		this._renderer.needsRender(() => {
			this.update(/* force */ true);
		}, undefined, this._disposables);

		vscode.workspace.onDidChangeConfiguration(() => {
			this.updateConfiguration();
		}, null, this._disposables);

		this.updateConfiguration();
		this.update();
	}

	dispose() {
		let item: vscode.Disposable | undefined;
		while ((item = this._disposables.pop())) {
			item.dispose();
		}
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
				this.update(/* force */ true);
			}
		});

		webviewView.onDidDispose(() => {
			this._view = undefined;
		});

		this.updateTitle();
		webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

		this.update(/* force */ true);
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

				<link href="${styleUri}" rel="stylesheet">
				
				<title>Definition View</title>
			</head>
			<body>
				<article id="main"></article>

				<script nonce="${nonce}" src="${scriptUri}"></script>
			</body>
			</html>`;
	}

	private async update(ignoreCache = false) {
		if (!this._view) {
			return;
		}

		this.updateTitle();

		if (this._pinned) {
			return;
		}

		const newCacheKey = createCacheKey(vscode.window.activeTextEditor);
		if (!ignoreCache && cacheKeyEquals(this._currentCacheKey, newCacheKey)) {
			return;
		}

		this._currentCacheKey = newCacheKey;

		if (this._loading) {
			this._loading.cts.cancel();
			this._loading = undefined;
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

            if (contentInfo.jmpUri) {
                this.currentUri = contentInfo.jmpUri;
                this.currentLine = contentInfo.startLine;
            }

			if (contentInfo.content.length) {
                //console.debug(`uri = ${contentInfo.content} startLine = ${contentInfo.startLine} endLine = ${contentInfo.endLine}`);
				this._view?.webview.postMessage({
					type: 'update',
					body: contentInfo.content,
					updateMode: this._updateMode,
                    scrollToLine: contentInfo.startLine+1
				});
			} else {
				this._view?.webview.postMessage({
					type: 'noContent',
					body: 'No symbol found at current cursor position',
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

	private async getHtmlContentForActiveEditor(token: vscode.CancellationToken): Promise<FileContentInfo> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			return { content: '', startLine: 0, endLine: 0, jmpUri: undefined };
		}

		let definitions = await this.getDefinitionAtCurrentPositionInEditor(editor);

		if (token.isCancellationRequested || !definitions || definitions.length === 0) {
			return { content: '', startLine: 0, endLine: 0, jmpUri: undefined };
		}

		return definitions?.length ? await this._renderer.renderDefinitions(editor.document, definitions) : {
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
