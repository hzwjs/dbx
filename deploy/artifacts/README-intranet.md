# DBX ARM64 内网介质

文件：`dbx-arm64-local-fixed.tar.gz`

在内网 ARM64 Docker 主机上导入：

```bash
docker load -i dbx-arm64-local-fixed.tar.gz
docker image inspect dbx:arm64-local-fixed
```

启动时使用同目录的 `docker-compose.arm64.yml`：

```bash
DBX_PASSWORD='替换为内网密码' docker compose -f docker-compose.arm64.yml up -d
```

或直接运行：

```bash
docker run -d --name dbx \
  -p 4224:4224 \
  -e DBX_PASSWORD='替换为内网密码' \
  -v dbx-data:/app/data \
  dbx:arm64-local-fixed
```

镜像已内置 JRE 21、Apache RocketMQ Agent 和 Web 静态资源，不需要内网主机联网下载这些组件。
