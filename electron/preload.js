// preload.js — 页面当前不需要 IPC（数据全走同源 /api）。
// 保留这个文件是为了让壳和页面之间有一条明确的、受控的通道，而不是把 node 直接开给渲染进程。
'use strict';

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('modelConsole', {
  platform: process.platform,
  versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
});
