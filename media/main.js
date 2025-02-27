//@ts-check

(function () {
    // @ts-ignore
    const vscode = acquireVsCodeApi();

    const main = document.getElementById('main');

    // const startingState = vscode.getState();

    // if (startingState) {
    //     if (startingState.body) {
    //         updateContent(startingState.body);
    //     } else if (startingState.noContent) {
    //         setNoContent(startingState.noContent);
    //     }
    // }

    let hasUpdated = false;

    // Handle messages sent from the extension to the webview
    window.addEventListener('message', event => {
        const message = event.data; // The json data that the extension sent
        console.debug(`message: ${message}`);
        switch (message.type) {
            case 'update':
                {
                    vscode.postMessage({ 
                        type: 'log', 
                        message: `Received message: ${JSON.stringify(message)}`
                    });
                    updateContent(message.body);
                    hasUpdated = true;
                    if (message.scrollToLine) {
                        console.log(`Trying to scroll to line: ${message.scrollToLine}`);
                        // 移除之前的高亮
                        document.querySelectorAll('.line.highlight').forEach(el => {
                            el.classList.remove('highlight');
                        });
                        
                        // 找到对应行的元素并滚动
                        const lineElement = document.querySelector(`[data-line="${message.scrollToLine}"]`);
                        if (lineElement) {
                            // 添加高亮
                            lineElement.classList.add('highlight');
                            // 滚动到该元素
                            lineElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            console.log(`Scrolled and highlighted element:`, lineElement);
                        } else {
                            console.log(`Could not find element with data-line="${message.scrollToLine}"`);
                        }
                    }
                    break;
                }
            case 'noContent':
                {
                    if (!hasUpdated || message.updateMode === 'live') {
                        setNoContent(message.body);
                    }
                    hasUpdated = true;
                    break;
                }
        }
    });

    /**
     * @param {string} contents
     */
    function updateContent(contents) {
        main.innerHTML = contents;
        // vscode.setState({ body: contents });
    }

    /**
     * @param {string} message
     */
    function setNoContent(message) {
        main.innerHTML = `<p class="no-content">${message}</p>`;
        // vscode.setState({ noContent: message });
    }
}());
