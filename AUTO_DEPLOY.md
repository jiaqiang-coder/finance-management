# 衡资自动部署：一次安装，之后推送即可

## 工作方式

1. 推送代码到 main，GitHub 托管的 Actions 运行 Hengzi CI。
2. 阿里云服务器每五分钟主动访问 GitHub，检查 main 当前提交的 push CI。
3. CI 未结束或失败则保留当前线上版本。CI 成功才下载该提交的不可变源码。
4. 备份四个运行时文件和 SQLite 数据库；短暂停止 hengzi-fm，写入代码，启动后检查登录页、JS 内容与匿名 API 的401保护。
5. 失败则恢复旧代码、重启并检查。不自动恢复数据库，避免覆盖部署窗口内的新记录；数据库备份保留供人工恢复。

不需要 GitHub SSH 登录服务器、SSH 私钥、阿里云 AccessKey 或 GitHub Token。只支持当前这个公开仓库。服务器必须能访问 api.github.com、raw.githubusercontent.com 和 codeload.github.com。

## 一次性安装

前提：已有 /opt/hengzi-app、挂载的数据目录 /opt/hengzi-app/data 和容器 hengzi-fm；系统有 Python3、curl、Docker、systemd。现有 Node 24 容器继续使用，无需在宿主机安装 Node。

在阿里云命令助手以 root 执行，或在 Workbench 中用 sudo。将下方 VERSION 替换为包含自动部署功能的完整40位提交SHA；安装脚本与代理固定从同一提交获取。

```bash
VERSION=包含自动部署功能的完整40位提交SHA
curl -fL --retry 2 \
  "https://raw.githubusercontent.com/jiaqiang-coder/finance-management/$VERSION/scripts/install-auto-deploy.sh" \
  -o /tmp/hengzi-install-auto-deploy.sh \
&& sudo bash /tmp/hengzi-install-auto-deploy.sh "$VERSION"
```

安装仅新增 hengzi-auto-deploy.service 和 hengzi-auto-deploy.timer。首次检查在后台运行；CI 尚未通过时日志显示 WAITING，稍后自动重试。

## 查看是否成功

```bash
sudo systemctl list-timers hengzi-auto-deploy.timer --no-pager
sudo journalctl -u hengzi-auto-deploy.service -n 40 --no-pager
sudo cat /opt/hengzi-deploy/deployed.json
```

- DEPLOYED + 提交SHA：部署成功。
- UP TO DATE：已经是当前版本。
- WAITING：等待当前 main 的 CI 通过；到 GitHub 的 Actions 页面查看测试。
- FAILED：未成功部署，检查日志；有些失败发生在改动前，更新后的失败会尝试回滚旧代码。
- GitHub API 限流、网络失败时不会绕过 CI 检查；下次定时任务再重试。

首次部署后打开 /app/fm/，重新登录并强制刷新。核对账户、预算、汇率页面；本地测试和HTTP健康检查不替代实际浏览器验收。

## 以后如何更新

只把验证过的代码推送/合并到 main。GitHub Actions 测试通过后通常在下一个五分钟检查周期部署。不要在服务器直接修改运行代码，这些文件会被后续部署覆盖。

每次部署有短暂重启，内存登录会话失效，需要重新登录。部署过程只运行应用源码，不自动安装新的npm运行时依赖；如果新增 dependencies，会明确拒绝部署，需要先调整容器构建方式。

更新器自身不会随 main 自动升级。修改部署代理后，需要再次运行对应提交的安装命令；这能避免常规应用更新顺带更换宿主机部署逻辑。

## 不影响现有站点与数据

- 仅替换 /opt/hengzi-app/server.js、public/app.js、public/index.html、public/login.html。
- 不替换根目录，保留 Docker 绑定挂载的目录 inode。
- 不替换 data/，不读取或更改 /opt/hengzi.env，不修改密码。
- 不重启博客、sub2api、Caddy，不修改代理配置或防火墙。
- 备份：/opt/hengzi-backups/时间-提交SHA/；不会自动删除备份，需定期检查磁盘空间。
- 单次部署用文件锁防止并发，只有部署健康检查通过才更新已部署版本记录。

## 立即检查、暂停与恢复

```bash
# 立即检查一次
sudo systemctl start hengzi-auto-deploy.service

# 暂停后续自动更新，不停止衡资应用
sudo systemctl disable --now hengzi-auto-deploy.timer

# 恢复
sudo systemctl enable --now hengzi-auto-deploy.timer
```

## 测试

GitHub 托管的 Ubuntu runner 使用 Node 24 和 Python3，运行 npm test、安装脚本语法检查、tests/test_auto_deploy.py。不在生产服务器安装 GitHub self-hosted runner，不执行来自PR分支的部署任务。
