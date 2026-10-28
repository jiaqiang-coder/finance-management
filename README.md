# 衡资

个人资产负债、投资持仓、收支流水、预算预警与周月报管理应用。

## 运行

要求 Node.js 22.5 或更高版本。

```bash
git clone https://github.com/jiaqiang-coder/finance-management.git
cd finance-management
APP_PASSWORD="请换成你的密码" npm start
```

应用挂载于 `/app/fm`，服务默认监听 `127.0.0.1:4173`，通过 HTTPS 反向代理访问，详见 [DEPLOYMENT.md](DEPLOYMENT.md)。

未设置 `APP_PASSWORD` 时，开发密码为 `hengzi-demo`。正式部署前必须修改。

## 数据

- SQLite 数据库存放在 `data/hengzi.db`。
- 首次启动会自动创建表；已禁用演示数据自动初始化。
- 删除数据库文件会丢失全部本地数据，请定期备份。
- CSV 导入会根据日期、交易方、金额和账户生成去重指纹。

## 已实现

- 密码登录与受保护 API
- 账户、资产和负债持久化
- 收入、支出、转账、证券交易和房贷还款流水
- 房贷本金与利息拆分
- 分类预算和阈值预警
- 周/月收支报告
- CSV 导入预览、去重和提交
- 流水 CSV 导出
- 响应式桌面和移动端界面

## 生产化前仍需完成

- 接入正式身份系统并启用 HTTPS
- 将 SQLite 迁移到托管 PostgreSQL
- 对接合规的 A 股、美股、基金、期权和汇率数据源
- 增加自动备份、操作审计与敏感字段加密
