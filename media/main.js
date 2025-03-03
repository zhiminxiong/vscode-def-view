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

    // 监听整个代码区域的双击事件
    window.addEventListener('dblclick', (e) => {
        // 检查双击的目标元素是否直接是main元素
        //if (e.target === main) {
            // 如果是直接点击在main元素上（空白区域），则发送消息
            vscode.postMessage({
                type: 'areaDoubleClick',
                line: 0
            });
        //}
    });

    let loadingTimer = null;

    // 延迟显示loading并添加透明度过渡
    function showLoading() {
        loadingTimer = setTimeout(() => {
            const loading = document.querySelector('.loading');
            loading.classList.add('show');
            loading.classList.add('active');
        }, 100);
    }

    // 先淡出loading再移除active类
    function hideLoading() {
        if (loadingTimer) {
            clearTimeout(loadingTimer);
            loadingTimer = null;
        }
        const loading = document.querySelector('.loading');
        loading.classList.remove('show');
        setTimeout(() => {
            loading.classList.remove('active');
        }, 200);
    }

    // Handle messages sent from the extension to the webview
    window.addEventListener('message', event => {
        const message = event.data; // The json data that the extension sent
        //console.debug(`message: ${message}`);
        switch (message.type) {
            case 'startLoading':
                showLoading();
                break;
            case 'endLoading':
                hideLoading();
                break;
            case 'update':
                {
                    // vscode.postMessage({ 
                    //     type: 'log', 
                    //     message: `Received message: ${JSON.stringify(message)}`
                    // });
                    updateContent(message.body);
                    hasUpdated = true;
                    if (message.scrollToLine) {
                        //console.log(`Trying to scroll to line: ${message.scrollToLine}`);
                        // 移除之前的高亮
                        // document.querySelectorAll('.line.highlight').forEach(el => {
                        //     el.classList.remove('highlight');
                        // });
                        
                        // 找到对应行的元素并滚动
                        const lineElement = document.querySelector(`[data-line="${message.scrollToLine}"]`);
                        if (lineElement) {
                            // 添加高亮
                            //lineElement.classList.add('highlight');
                            // 滚动到该元素
                            lineElement.scrollIntoView({ behavior: 'auto', block: 'center' });//'smooth'
                            //console.log(`Scrolled and highlighted element:`, lineElement);

                            // 添加双击事件监听器
                            // lineElement.addEventListener('dblclick', () => {
                            //     // 发送消息给插件
                            //     vscode.postMessage({
                            //         type: 'lineDoubleClick',
                            //         line: message.scrollToLine
                            //     });
                            // });
                        } else {
                            //console.log(`Could not find element with data-line="${message.scrollToLine}"`);
                        }
                    }
                    hideLoading();
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
