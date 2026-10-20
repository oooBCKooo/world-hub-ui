# World Hub UI

[English](README.en.md)

World Hub 的独立界面项目。提供通讯拓扑、手动工作台、模块本体／配置／数据管理与社区页面。Hub 本身可独立运行，其他程序通过 HTTP／WebSocket 契约使用它，不需要安装或打开本项目。

[Hub 项目](https://github.com/oooBCKooo/world-hub) · [界面操作约定](docs/interface-ux.md) · [手动通讯工作台](docs/specs/manual-workbench.md)

## 启动

需要 Node.js 22.4 或以上，无第三方运行依赖。界面使用独立的 npm 包 `world-hub-ui`，不包含或自动安装 `world-hub`。先按 World Hub 文档启动 Hub，再安装并启动界面：

```powershell
npm install -g world-hub-ui
world-hub-ui --hub http://127.0.0.1:8790 --open
```

终端会打印实际界面地址。`--port 9000` 指定界面端口；默认由系统选择。UI 会读取 Hub 声明的 WebSocket 路径，Hub 暂未启动或使用特殊路径时可明确指定 `--bridge-path /bridge`。

UI 与 Hub 是两个独立进程。关闭 UI 不会停止 Hub。UI 没有启动、拥有或自动升级 Hub 的隐式行为；界面的模块操作通过 Hub 管理 API 执行。

## 通讯边界

本地 UI 只监听 `127.0.0.1`，仅连接显式指定的本机回环 Hub HTTP origin。页面和代理具有相同 origin。代理只转发 `/manage/api/**`、只读 `/status`／`/log` 及明确的桥 WebSocket 路径。

浏览器请求先核对 UI 的 Host、Origin 和 Fetch Metadata，再向固定 Hub 转发；操作令牌原样交给 Hub 校验。没有通用 URL 代理、跨域授权、自动重试写操作或桥身份代办。手动桥仍由浏览器发送自己的 hello 和桥凭据。Hub默认不预置界面专用身份；使用手动收发前需由部署方明确配置桥身份、token和主题权限，界面不会自行扩大ACL。

`/debug` 提供只读通讯诊断。Hub 停止时页面可以保持打开，操作明确返回 Hub 不可用。

## 社区页面

`tools/workshop/public/` 是独立的社区静态页面，使用固定 `/workshop/` 路径。它与管理界面共享项目，但社区账号不控制本机 Hub。

部署时将这一目录明确传给 World Hub Workshop 后端／网关的外部静态目录选项。Node 使用方可读取公开导出的目录位置：

```javascript
import { workshopAssetsRoot } from 'world-hub-ui/workshop-assets';
```

页面和 Workshop API 应保持同源，以保留原有 Cookie 与 CSRF 校验。这个本地管理 CLI 不代理公网社区账号接口，也不读取其凭据。

## 开发与验证

从源码运行：

```powershell
npm ci --ignore-scripts
node bin/world-hub-ui.mjs --hub http://127.0.0.1:8790 --open
npm test
npm run check
```

可选的真实 Hub 公开 CLI 合约验收：

```powershell
$env:WORLD_HUB_ENTRY = 'C:\your-installed-hub\bin\world-hub.mjs'
node --test tests/proxy/hub-contract.test.mjs
```

该验收启动独立临时 Hub，验证 HTTP 操作令牌、浏览器桥原始信息与两个进程分别关闭；默认测试不要求另一个仓库存在。

`src/server.mjs` 导出 `createUIServer({ hub, port, bridgePath })`；返回 `url`、`origin`、`bridgePath` 和异步 `close()`。运行期不导入 Hub 仓库内部文件，也不要求两个仓库相邻。

管理界面读取 `/manage/api/state` 的 `transport.path`、`csrfToken` 和通讯诊断，并调用 `/manage/api/` 下的管理资源；这些 HTTP／WS 契约属于 Hub。修改界面不改变 Hub 数据、ACL 或线协议。

许可：MIT。
