# 问题记录 — 项目列表加载失败：nginx 把集合端点 301 到带斜杠版本

## 现象

容器化部署（`apitest-web` 镜像内 nginx 反代 `/api` 到后端）后，登录成功但**项目加载失败**。
浏览器 Network 里 `GET /api/v1/projects` 返回 **301**，Location 指向 `/api/v1/projects/`，
前端项目列表拿不到数据；直接访问后端 `:3000` 的同名路径却是 200。

## 根因

`apitest-web/deploy/nginx.container.conf.template` 里，为 SSE 长连接（执行流 / 助手对话流）
声明了以斜杠结尾的前缀 location（当时另有一份裸机版 `deploy/nginx.conf`，同一段，后已删除）：

```nginx
location ^~ /api/v1/projects/ { proxy_pass http://apitest_backend; ... }
```

nginx 的既定行为：当前缀 location **以 `/` 结尾**且用 `proxy_pass` 时，对「同前缀但不带斜杠」
的请求会自动 **301 到带斜杠版本**。而 `/api/v1/projects` 恰好是项目**集合**端点（列表 `/projects`
与新建 `POST /projects`），被重定向成 `/api/v1/projects/` 后，后端按 `/api/v1/projects/:id`
解析 `:id=""`，抛

```
error: invalid input syntax for type uuid: ""   (SQLSTATE 22P02)
```

返回 500，前端表现为「项目加载失败」。

为什么 dev 不复现：`vite` 的 `server.proxy` 是纯转发、没有这条尾斜杠自动重定向语义；只有
nginx 反代部署才撞上，所以此前一直没被发现。

## 修法

在 nginx 配置里，于 SSE 块**之前**加一条精确匹配 location 把集合端点钉住（`=` 匹配优先
于任何前缀匹配，也优先于 `^~`）：

```nginx
location = /api/v1/projects {
    proxy_pass http://apitest_backend;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection "";
}
```

SSE 只服务带子路径的请求（`/api/v1/projects/:id/...`），语义不变。

## 状态

已修（2026-10-24）。改动落在 nginx 配置（`apitest-web/deploy/nginx.container.conf.template`；
裸机版 `deploy/nginx.conf` 同步修过，后因只走容器部署已删除），未动后端路由/信封/SQL。重出
`apitest-web` 镜像后实测：`GET /api/v1/projects -> 200`（返回项目列表），
`/api/v1/projects/:id`、`.../executions`、`.../executions/stream` 均正常代理到后端。