import * as vscode from 'vscode';
import { CodeHighlighter } from './codeHighlighter';

export interface FileContentInfo {
    content: string;
    startLine: number;
    endLine: number;
    jmpUri: vscode.Uri | undefined;
}

export class Renderer {

	private readonly _disposables: vscode.Disposable[] = [];

	private readonly _highlighter: CodeHighlighter;

	public readonly needsRender: vscode.Event<void>;

	constructor() {
		this._highlighter = new CodeHighlighter();
		this._disposables.push(this._highlighter);

		this.needsRender = this._highlighter.needsRender;
	}

	dispose() {
		let item: vscode.Disposable | undefined;
		while ((item = this._disposables.pop())) {
			item.dispose();
		}
	}

	public async renderDefinitions(document: vscode.TextDocument, definitions: readonly vscode.Location[] | vscode.LocationLink[]): Promise<FileContentInfo> {
		let docs: FileContentInfo[] = [];

		for (const def of definitions) {
			if (def instanceof vscode.Location) {
				docs.push(await this.getFileContentsEx(def.uri, def.range));
			} else {
				docs.push(await this.getFileContentsEx(def.targetUri, def.targetRange));
			}

		}

		const parts = docs
			.filter(info => info.content.length > 0)
			.map(info => info.content);

		if (!parts.length) {
			return { content: '', startLine: 0, endLine: 0, jmpUri: undefined }
		};

		const code = parts.join('\n');

		const highlighter = await this._highlighter.getHighlighter(document);
        return {
			content: highlighter(code, document.languageId),
			startLine: docs[0].startLine,
			endLine: docs[0].endLine,
            jmpUri: docs[0].jmpUri
		};
	}

    private async getFileContentsEx(uri: vscode.Uri, range: vscode.Range): Promise<FileContentInfo> {
        console.warn(`getFileContentsEx: ${uri}`);
        const doc = await vscode.workspace.openTextDocument(uri);
		// console.debug(`uri = ${uri}`);
		// console.debug(`range = ${range.start.line} - ${range.end.line}`);

		// Read entire file.
		const rangeText = new vscode.Range(0, 0, doc.lineCount, 0);
		let lines = doc.getText(rangeText).split(/\r?\n/);
        let firstLine = range.start.line;
        let lastLine = range.end.line;

        //console.debug(`uri = ${uri} firstLine = ${firstLine} lastLine = ${lastLine}`);

        return {
			content: lines.join("\n") + "\n",
			startLine: firstLine,
			endLine: lastLine,
            jmpUri: uri
		};
    }

	private async getFileContents(uri: vscode.Uri, range: vscode.Range): Promise<string> {
		const doc = await vscode.workspace.openTextDocument(uri);
		// console.debug(`uri = ${uri}`);
		// console.debug(`range = ${range.start.line} - ${range.end.line}`);

		// Read entire file.
		const rangeText = new vscode.Range(0, 0, doc.lineCount, 0);
		let lines = doc.getText(rangeText).split(/\r?\n/);
		let indent = lines[range.start.line].search(/\S/);

		// First, capture any preceding lines that may be important.
		// Typically only comments and attributes.
		const prefixes = ['@', '/', '#', '[', ';', '-'];
		let firstLine = range.start.line;
		for (let n = range.start.line - 1; n >= 0; n--) {
			let lineIndent = lines[n].search(/\S/);
			if (lineIndent < indent) {
				break;
			}

			if (lines[n].length === 0) {
				break;
			}

			// Only allow lines starting with specific chars.
			// Typically comments.
			if (!prefixes.includes(lines[n].trim().charAt(0))) {
				break;
			}

			firstLine = n;
		}

		// Now capture any remaining lines until the end of the function.
		let lastLine = range.end.line;

		let insideBlock = false;
		// Hack for C#/Godot definitions with no function body.
		// Also for variable defs.
		let trimmedStart = lines[range.start.line].trim();
		if (trimmedStart.search(/;$/) >= 0) {
			insideBlock = true;
		}

		for (let n = range.start.line; n < lines.length; n++) {
			let lineIndent = lines[n].search(/\S/);
			let trimmedLine = lines[n].trim();

			let firstChar = trimmedLine.charAt(0);
			let lastChar = trimmedLine.charAt(trimmedLine.length - 1);

			if (trimmedLine.length > 0) {
				// Keep searching until the next non-blank line that is 
				// at a shorter indent level.
				if (lineIndent < indent) {
					break;
				} else if (insideBlock && lineIndent === indent) {
					// Ignore {
					// For C#/C/C++ where the { is on the next line.
					if (firstChar === '{') {
						if (n > lastLine) {
							lastLine = n;
						}
						continue;
					}

					// If the character is ), include it and keep going.
					// This catches things like this:
					// ```
					// fn some_func(
					//     a: String	
					// ) {
					// ```
					if (firstChar === ')') {
						if (n > lastLine) {
							lastLine = n;
						}
						continue;
					}

					// If the character is }, include it.
					// Otherwise, exclude it (for languages like Python, 
					// this would be the start of the next function)
					if (firstChar === '}') {
						if (n > lastLine) {
							lastLine = n;
						}
					}

					break;
				}

				// Nasty hacks :P
				let inBlockFirstChars = ['{'];
				let inBlockLastChars = [':', '{', ';', '}'];
				if (lineIndent > indent || inBlockFirstChars.includes(firstChar) || inBlockLastChars.includes(lastChar)) {
					insideBlock = true;
				}

				if (n > lastLine) {
					lastLine = n;
				}
			}
		}
		lines = lines.slice(firstLine, lastLine + 1).map((x) => { return x.substring(indent) });
		return lines.join("\n") + "\n";
	}
}
