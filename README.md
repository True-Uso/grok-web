# Super Coding（grok-web）

面向国内用户的网页版编程助手。浏览器里对话、预览、下载和发布项目。模型走 DeepSeek，后台调用本机或镜像里的 `grok` 智能体。

这不是 [grok-build](https://github.com/xai-org/grok-build) 源码。那个仓库用来编译 `grok` 命令行；本仓库是网站。

## 本地运行

需要：Node.js 22、已安装的 `grok` 命令、DeepSeek API Key。做带数据库的系统时还要 Docker。

```sh
cp .env.example .env
# 编辑 .env，填写 DEEPSEEK_API_KEY
npm install
npm start
```

打开 http://127.0.0.1:8787 先看到主页。工作台在 `/app`。

默认预置账号（可在 `.env` 改 `SC_BOOTSTRAP_USER` / `SC_BOOTSTRAP_PASS`）：

- 账号 `admin`
- 密码 `coding123`

## 服务器 Docker 部署

在 Linux（如阿里云）上安装 Docker 后：

```sh
cp .env.example .env
# 编辑 .env，填写 DEEPSEEK_API_KEY
docker compose up -d --build
```

构建时会下载 Linux 版 `grok`。访问 `http://服务器IP:8787`。安全组放行 8787。

Windows 本机不要用这套 Compose（使用了 Linux 的 `host` 网络）。

## 不会上传的内容

`.env`、`.token`、`data/`、用户项目和密钥都已忽略，不要提交。
