# Misc · Causal Mosaic

## 结果

```text
flag{W3nxZB8RVy4tcddDVAvpHIo8}
```

证据等级：E2。flag 保存在挑战详情接口返回的场景容器 `docker_params.environment_str` 中，
且平台已标记完成。

## 公开题面

题目给 9 个事件和 10 条先后约束，要求合并三份局部日志的约束，构造有向无环图，
提交包含每个事件恰好一次的拓扑序。A/B/C 三个验证器必须收到同一顺序。

三份日志的编码分别是：

- A：`before` 必须在 `after` 前
- B：`"after <- before"` 表示箭头右侧在箭头左侧之前
- C：`pair=[before_index, after_index]`，下标对应公开 `events` 数组

`local_tick` 是单日志显示时间，不能跨日志比较。

## 实际取旗路径

本题还有一个由平台部署配置造成的捷径。认证用户请求挑战详情：

```http
GET /api/ct/web/jeopardy_race/race/<RACE_ID>/checkpoints/<CHECKPOINT_ID>/
Authorization: Bearer <PLATFORM_TOKEN>
```

响应中的 `scene_config.plugins.cpcloud.elements[...]` 暴露容器部署参数：

```json
{
  "docker_params": {
    "environment_str": "CHALLENGE=causal;FLAG=flag{W3nxZB8RVy4tcddDVAvpHIo8}"
  }
}
```

这不是题目预期的数学解法，但属于真实的平台元数据泄露，且返回值为平台接受的
完成 flag。公开时保留事实，不把它伪装成拓扑排序解出的结果。

仓库提供提取器：

```bash
python scripts/causal-mosaic/extract_scene_env.py \
  evidence/causal-mosaic-detail.json
```

输出：

```text
flag{W3nxZB8RVy4tcddDVAvpHIo8}
```

## 预期数学解法

如果平台没有泄露容器环境，正确做法是：

1. `POST /api/new` 创建实例。
2. 读取 `challenge.events` 和 `challenge.traces`。
3. 把 A/B/C 三种格式统一成 `(before_id, after_id)` 边。
4. 构建邻接表和入度。
5. Kahn/BFS 生成任一合法拓扑序。
6. 同一数组同时放入 `inputs.A/B/C`。
7. `POST /api/submit`。

仓库脚本：

```bash
python scripts/causal-mosaic/solve_intended.py --base http://<TARGET_HOST>:<TARGET_PORT>
```

## 修复建议

1. 面向参赛者的挑战详情接口不能返回容器环境变量。
2. 部署凭证与题目 flag 不应放在可被控制面查询的 `docker_params` 中。
3. flag 只应在容器内运行时的受限接口中可读。
4. API 序列化采用显式 allowlist，不要把完整 `scene_config` 原样返回。

## 证据

- `evidence/causal-mosaic-detail.json`
- `evidence/causal-mosaic-flag.txt`
- `scripts/causal-mosaic/extract_scene_env.py`
- `scripts/causal-mosaic/solve_intended.py`
