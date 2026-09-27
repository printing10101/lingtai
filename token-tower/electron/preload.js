// 页面与壳之间的窄桥：只暴露文件夹选择对话框，其余一律不给
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wb', {
  chooseFolder: () => ipcRenderer.invoke('wb-choose-folder'),
});
