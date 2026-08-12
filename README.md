# reBotArm 平台（rebotarm-platform）

reBot B601-RS（6 旋转关节 + 1 夹爪）机械臂的本机 Web 控制台。包含 React 前端、
FastAPI + motorbridge 0.5.1 后端、动作轨迹处理、真实 MIT 老化循环，以及 Jetson
用户态部署脚本（版本化 release + 原子切换 + 回滚）。

> **当前阶段（2026-08-12）**：真机 Web 控制台已上线。动作中心录制 raw → 固定速度
> 轨迹处理（自动钳制到限位内留安全余量）→ 保存到后端 **Trajectory 动作库**；老化按
> 动作 ID 从 Trajectory 读取，以 **MIT 位置伺服模式**执行循环动作并同时记录遥测。
> 零重力拖拽录制、机械零位、MIT 模式确认、老化周期均已人工验证通过。

## 目录树

```
reBotArm_web/
├── apps/
│   ├── web/                    React 18 + TypeScript + Vite + R3F 前端
│   └── server/                 FastAPI + motorbridge 0.5.1 后端
├── packages/
│   ├── robot-description/      机器人描述预留目录
│   └── shared/                 共享协议预留目录
├── docs/
│   ├── product/                UI 规格
│   └── architecture/           项目结构与目录职责
├── deploy/
│   ├── linux/                  Linux 部署占位
│   └── jetson/
│       ├── bin/                rebotarm-{can-init,start,stop,health}.sh
│       ├── env/                Jetson 环境模板
│       ├── make_release.sh     release 打包器（开发机/本机）
│       ├── install_release.sh  用户态 release 安装器（Jetson）
│       └── SOURCE_DEPLOYMENT.md  完整部署指南
├── deploy.sh                   Jetson 源码一键部署入口（在 JetSon 上含源码时使用）
├── .gitignore
├── package.json                根 workspace（rebotarm-platform）
└── README.md                   本文件
```

## 开发命令（仓库根目录）

```bash
npm ci
npm run dev          # 开发服务器 :5173（/api 与 /ws 代理到后端 :8000）
npm run type-check   # TypeScript 严格检查
npm run test --workspace @rebotarm/web   # 前端测试
npm run build        # 生产构建（产物 apps/web/dist/）
```

后端：

```bash
cd apps/server
python3.10 -m venv .venv && . .venv/bin/activate   # Windows: .venv\Scripts\activate
python -m pip install -e '.[dev]'                  # 或 .venv\Scripts\python -m pip ...
python -m pytest -q                                # 后端测试（不连 CAN）
python -m rebot_server                             # 启动后端（默认 127.0.0.1:8000）
```

后端测试使用模拟适配器/mock，不连接 CAN；真机 motorbridge 适配器在 `REBOT_ADAPTER=motorbridge`
启动时固定校验 motorbridge 恰好 0.5.1（fail closed）。

## 五大页面（apps/web）

| 页面    | 作用 |
|---------|------|
| 实时监控 | 3D 视窗（高度可拖拽）+ 7 电机表 + 通信指标 |
| 关节趋势 | 位置/速度/扭矩/温度切换与多关节叠加 |
| 动作中心 | 零力矩拖拽录制 → 固定速度轨迹处理 → 保存到 Trajectory |
| 老化测试 | 从 Trajectory 选动作，按 ID 以 MIT 模式循环执行并记录遥测 |
| 日志中心 | 会话表 + 筛选 + 详情 + CSV |

## 关键设计

### Trajectory 动作库
- 动作真实存储在后端部署目录 **`$BASE/Trajectory/`**（与老化日志 `$BASE/log/` 同级）。
- 动作中心保存 processed 动作 → 写入 Trajectory；老化页面从 Trajectory 列出可选动作。
- 老化启动传 `action_id`，后端从 Trajectory 读取动作、校验后执行。

### 老化执行（MIT 模式）
- 启动：自动退出零力矩 → `disable` → `ensure_mode(MIT)` ×3 → 读 `0x7005(make)`
  确认 run_mode=0 → `enable` → 以 MIT 发送 `send_mit(pos, 0, kp, kd, 0)`。
- MIT 增益每关节配置（`REBOT_MIT_KP/KD`，参考 `reBotArm_control/config/rebotarm_rs.yaml`）。
- 遥测与动作共享同一 Controller，通过总线锁互斥：遥测把总线繁忙视为正常竞争、
  不 fail-closed；老化获取总线带重试。
- 回零验证容差 0.03 rad（MIT 位置伺服在重力/摩擦下的稳态残差）。

### 温度保护（老化）
老化页面可设置「温度保护 °C」（可选，留空则不限制）。老化执行中逐帧读取遥测的
**MOS 温度**，任一关节 ≥ 设定值即触发：
- 自动停止并**归位（回零）**、失能；
- 状态卡片显示「温度保护触发：Mx 温度 xx°C 达到上限」；
- 该会话 `$BASE/log/<session>/events.jsonl` 追加审计事件：
  ```json
  {"type":"safety_temp_exceeded","joint_id":5,"temperature_c":85.3,"limit_c":80}
  ```

### 限位安全余量
- 轨迹处理时把每个样本钳制到 `[下限+余量, 上限−余量]`（默认 0.05 rad），
  机械臂永远动不到限位外；录制压到机械挡块也能正常生成动作。

## 部署（Jetson）

真实部署为**用户态、版本化 release + 原子切换 + 回滚**，不使用 Docker/systemd。

### 方式 A：开发机打包，Jetson 安装（推荐）
```bash
# 1. 开发机：打包
sh deploy/jetson/make_release.sh "<release-id>"

# 2. 上传到 Jetson
scp deploy/jetson/out/rebotarm-release-<id>.tar.gz <user>@<host>:~/rebotarm-install/

# 3. Jetson：安装（保留现有 env，成功才切换 current）
sh ~/rebotarm-install/install_release.sh ~/rebotarm-install/rebotarm-release-<id>.tar.gz

# 4. Jetson：初始化 CAN（PCAN-USB，需 sudo）
sudo $BASE/bin/rebotarm-can-init.sh can1 1000000

# 5. 启动 / 健康检查 / 停止
$BASE/bin/rebotarm-start.sh
$BASE/bin/rebotarm-health.sh
$BASE/bin/rebotarm-stop.sh
```

### 方式 B：源码一键部署（Jetson 上已有源码）
```bash
cd /home/revolute1/rebotarm-src/reBotArm_web
sh deploy.sh                # 构建、测试、打包、安装、切换、健康检查（失败自动回滚）
sh deploy.sh --release-id my-id --base /home/revolute1/rebotarm-web
```

详细步骤、首次系统依赖、回滚见 [deploy/jetson/SOURCE_DEPLOYMENT.md](deploy/jetson/SOURCE_DEPLOYMENT.md)。

## 运行配置

现场配置文件 `$BASE/shared/env/rebotarm.env`（权限 600）核心项：

```dotenv
REBOT_ADAPTER=motorbridge
REBOT_CAN_CHANNEL=can1
REBOT_HOST_ID=0xFD
REBOT_TELEMETRY_HZ=10

REBOT_ALLOW_ACTIVE_REPORT_WRITE=1
REBOT_ALLOW_ENABLE_WRITE=1
REBOT_ALLOW_AGING_WRITE=1
REBOT_ALLOW_ZERO_TORQUE_WRITE=1
REBOT_ZERO_TORQUE_HZ=50

REBOT_HOST=127.0.0.1
REBOT_PORT=8000
REBOT_LOG_JSON=1
REBOT_LOG_LEVEL=INFO
```

- `REBOT_AGING_LOG_ROOT` 由启动脚本固定为 `$BASE/log`；`REBOT_TRAJECTORY_DIR` 固定为
  `$BASE/Trajectory`，均不由 UI 选择。
- MIT 增益可选：`REBOT_MIT_KP=50,150,150,50,50,50,50`、`REBOT_MIT_KD=3,10,10,5,4,4,4`。
- 门禁为 `1` 只表示对应接口在用户确认后可调用，服务启动不自动扫描/使能/回零/动作。

## 老化循环与日志

点击「启动老化」并确认后，后端把动作与日志作为同一生命周期启动：

```text
首次回零 → 平滑定位到动作起点 → processed 轨迹（MIT）
→ 回零验证 → 间隔 → 再次回零验证 → 下一轮
```

支持次数 / 时长 / 无限循环。MIT 发送频率 50Hz，使用绝对单调 deadline，延迟后不补发追赶帧。

- 老化遥测 CSV：`$BASE/log/<会话>/telemetry_*.csv`（每帧 7 行，每 5 分钟分片）；
  会话目录还含 `session.json`、`processed_action.json`、`events.jsonl`。
- 服务日志：`$BASE/shared/logs/server.out`。

## 主要 API

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/health` | 服务、适配器、capability |
| GET | `/api/robot/connection` | 当前连接状态 |
| POST | `/api/robot/scan` | 扫描 ID 1..7（操作者触发） |
| POST | `/api/robot/disconnect` | 释放连接所有权 |
| WS | `/ws/robot/telemetry` | 约 10Hz 实时遥测 |
| GET/POST | `/api/robot/zero-torque/{status,start,stop}` | 零力矩状态机 |
| GET/POST/DELETE | `/api/aging/actions` | Trajectory 动作库（列出/保存/删除） |
| GET/POST | `/api/aging/{status,start,stop}` | 老化状态与确认启停 |
| GET | `/api/aging/logs` | 固定日志目录与执行能力 |

写接口必须满足 capability 与确认要求；不要用部署或自动化脚本调用真机动作接口。

## 回滚

```bash
BASE=/home/revolute1/rebotarm-web
ls -1 "$BASE/releases"
readlink "$BASE/current"
```

确认老化和零力矩均未运行后，重装旧 release 的 `server` 包、更新 `current` 与 `bin`
脚本、重启并健康检查。`shared/env`、`shared/logs`、`log`、`Trajectory` 不随切换。

## 故障检查

- Node 版本不足：升级到 20.19+ / 22.12+。
- motorbridge 不是 0.5.1：服务 fail closed，不跳过版本门。
- `can1` 不存在或未 UP：跑 `sudo $BASE/bin/rebotarm-can-init.sh can1 1000000` 检查 PCAN-USB。
- 服务重启后未连接：UI 中操作者重新扫描（初始 `disconnected` 是预期）。
- 老化按钮不可用：确认完整连接、新鲜真机遥测、`REBOT_ALLOW_AGING_WRITE=1`、Trajectory 有动作。
- 老化报 `home verification failed`：机械臂仍应在零位附近，通常是 MIT 稳态残差，可核对 `log` 遥测。
- 页面停顿：确认 WebSocket 持续收到真实遥测。
- 服务无法启动：看 `shared/logs/server.out`，不要用 kill 代替 `rebotarm-stop.sh`。

## 参考工程

`reBotArm_control` 是独立参考工程（动作/控制的最初实现），不属于本仓库；本仓库不
引用、不修改、不包含其文件。