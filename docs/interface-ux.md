# 界面操作约定

World Hub UI 是独立的可视化客户端。先启动 Hub，再按 [README](../README.md) 指定 Hub 地址启动界面。界面关闭后 Hub 继续运行，Hub 不可用时页面仍可打开并报告连接错误。

画布提供已有模块、接线架构、启动编排和运行监控视图；模块资源中心分别管理模块本体、模块配置和模块数据。通讯工作台使用页面自己的枢纽桥，具体行为见[手动通讯](specs/manual-workbench.md)。

- 路径字段可使用本机选择器；原生选择不可用时保留路径输入。选择路径不等于导入或授权执行。
- 下载和导入显示资源种类、版本与摘要。配置、数据恢复和模块执行分别审阅，不沿用下载操作的授权。
- 配置引用模块本体，模块分组引用实例；共享成员的修改需要显示受影响范围，不复制进程。
- 接线、启动编排和运行状态从 Hub 管理 API 读取。进程健康、自报就绪和真实桥连接分别展示，不将缺失证据视为成功。
- 管理写操作保留 Hub 的操作令牌校验；浏览器枢纽桥仍需部署方明确配置身份、token 和主题权限。
- 写操作结果未知时展示回执和刷新入口，不自动重发。业务信息按原文展示，不由界面判定业务完成。
- 中英文界面和窄屏布局使用同一组资源及后端事实。

## English

World Hub UI is an independent client. Start the Hub separately, then select its local address as described in the [README](../README.en.md). Closing the UI leaves the Hub running; an unavailable Hub produces an explicit connection error.

The canvas offers modules, wiring, startup orchestration and runtime views. The resource center manages module bodies, configurations and data independently. Path selection does not authorize import or execution. Groups reference instances and configurations reference bodies. Shared changes, execution grants and data restoration require their own review. API operation tokens and bridge credentials remain under Hub control. Unknown write results are refreshed rather than retried automatically; displayed application payloads do not prove business completion.
