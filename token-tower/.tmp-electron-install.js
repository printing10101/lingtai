// 一次性脚本：electron 包的 postinstall 未自动完成时，显式触发其官方安装脚本下载二进制。
// 用后即删。
process.env.ELECTRON_MIRROR = process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/';
require('./node_modules/electron/install.js');
