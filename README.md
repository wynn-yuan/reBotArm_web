# reBotArm 平台（rebotarm-platform）

reBot B601-RS（6 旋转关节 + 1 夹爪）机械臂的本机 Web 控制台。包含 React 前端、
FastAPI + motorbridge 0.5.1 后端、动作轨迹处理、真实 MIT 老化循环、OTA 远程更新，
以及 Jetson 用户态部署脚本（版本化 release + 原子切换 + 回滚）。

> **当前阶段（2026-08-17）**：真机 Web 控制台已上线。动作中心录制 raw → 轨迹处理
> （抗尖峰滤波 + RDP 顶点提取 + 最小加加速度平滑）→ 保存到后端 **Trajectory 动作库**；
> 老化按动作 ID 从 Trajectory 读取，以 **MIT 位置伺服模式**执行循环动作并同时记录遥测。
> 零重力拖拽录制、机械零位、MIT 模式确认、老化周期均已人工验证通过。
> **新增**：OTA 远程更新（从 GitHub Releases 拉取 + 进度条 + 自动重启）；
> 录制时自动开启零力矩模式（无需手动进入）；URDF 模型升级至 v3；
> 回零校验模式可配置（warn 仅警告 / stop 终止老化）。

## 目录树

```
reBotArm_web/
├── apps/
│   ├── web/                    React 18 + TypeScript + Vite + R3F 前端
│   └── server/                 FastAPI + motorbridge 0.5.1 后端
├── packages/
│   ├── robot-description/      机器人 URDF 模型与 mesh 文件
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
├── deploy.sh                   Jetson 源码一键部署入口（在 Jetson 上含源码时使用）
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

### OTA 远程更新

顶栏右侧 🔄 按钮提供系统更新功能：

- **检查更新**：`GET /api/ota/check` 查询 GitHub Releases，对比当前版本
- **一键更新**：`POST /api/ota/update-from-github` 下载最新 release tarball，后台安装
- **进度追踪**：安装过程分步展示进度条（下载 → 停止 → 解压 → 安装 → 激活 → 启动 → 完成）
- **自动刷新**：更新完成后自动刷新页面
- **安全门禁**：老化或零力矩运行时拒绝更新（409）

更新流程由 `ota.py` 驱动，安装脚本在后台执行：停止服务 → 解压 → pip install → 原子切换
`current` 软链接 → 启动服务。服务重启后 `REBOTARM_BASE` 环境变量确保版本识别正确。

### 零力矩拖拽录制

动作中心「开始录制」按钮不再要求零力矩已激活。点击后自动调用 `startZeroTorque()`，
成功或失败均继续录制流程。录制结束后自动调用 `stopZeroTorque()` 退出零力矩模式。

> **注意**：`startRecord` 内部仍检查零力矩状态（通过 `useRef` 而非闭包捕获，避免竞态条件）。
> 若零力矩启动失败，录制会被拒绝并提示"零力矩模式未激活"。

### Trajectory 动作库
- 动作真实存储在后端部署目录 **`$BASE/Trajectory/`**（与老化日志 `$BASE/log/` 同级）。
- 动作中心保存 processed 动作 → 写入 Trajectory；老化页面从 Trajectory 列出可选动作。
- 老化启动传 `action_id`，后端从 Trajectory 读取动作、校验后执行。

### 轨迹处理模式

录制 raw 动作后，动作中心提供三种轨迹处理路径：

| 模式 | 触发条件 | 说明 |
|------|---------|------|
| 抗抖滤波 | `smoothingWindow > 0`（默认 13 帧） | 先去除瞬时尖峰，再提取形状控制点，用 PCHIP 连续插值平滑 |
| 顶点简化 | `keypointEpsilon > 0` | RDP 算法提取关键顶点 + 分段最小加加速度（minimum-jerk）插值 |
| 全路径重定时 | 以上均关闭 | 兼容旧版：去除重复点 + 梯形速度曲线 |

**关键参数**：
- `smoothingWindow`：抗抖窗口（奇数帧），轻度 7/标准 13/强力 21
- `preserveRecordedTiming`：保留录制时各顶点之间的时间（默认开启）
- `returnHome`：自动在动作首尾补全回零动作
- 速度为硬限制（超速时拉伸时间），加速度为参考值（仅提示）

### 老化执行（MIT 模式）
- 启动：自动退出零力矩 → `disable` → `ensure_mode(MIT)` ×3 → 读 `0x7005(make)`
  确认 run_mode=0 → `enable` → 关闭主动上报 → 以 MIT 发送 `send_mit(pos, 0, kp, kd, 0)`。
- 每帧发送后**内联 poll**：在同一 bus 锁内接收电机回复状态帧，SDK 缓存即时更新。
- **遥测免锁**：老化运行时 `read_telemetry` 跳过 poll 和 bus 锁，直接读 SDK 缓存，
  遥测与老化零锁竞争(100Hz 下消除每秒 100 次抢锁)。
- **主动上报关闭**：老化期间 `robstride_set_active_report(False)`，减少 CAN 总线负载
  (MIT 回复帧已包含状态，无需额外上报)；老化结束后恢复。
- 执行频率 100Hz(录制/处理/执行统一)，回零验证容差 0.08 rad(MIT 稳态残差)。
- MIT 增益每关节配置（`REBOT_MIT_KP/KD`，参考 `reBotArm_control/config/rebotarm_rs.yaml`）。
- 跟随误差保护：连续 3 帧超限才报错，单帧瞬态跳过不中断。

### 回零校验模式

老化每轮结束后执行回零校验（`_verify_home`），最大等待 5 秒。超过容差后的行为可配置：

| 模式 | 行为 | 配置 |
|------|------|------|
| `warn`（默认） | 记录 `home_verification_failed` 事件 + warning 日志，**继续老化** | `REBOT_HOME_VERIFY_MODE=warn` |
| `stop` | 抛出 `AgingSafetyFault`，**终止老化**并进入 error 状态 | `REBOT_HOME_VERIFY_MODE=stop` |

容差通过 `REBOT_HOME_TOLERANCE_RAD` 配置（默认 0.08 rad ≈ 4.6°）。

### 温度保护（老化）
老化页面可设置「温度保护 °C」（可选，留空则不限制）。老化执行中逐帧读取遥测的
**MOS 温度**，任一关节 ≥ 设定值即触发：
- 自动停止并**归位（回零）**、失能；
- 状态卡片显示「温度保护触发：Mx 温度 xx°C 达到上限」；
- 该会话 `$BASE/log/<session>/events.jsonl` 追加审计事件：
  ```json
  {"type":"safety_temp_exceeded","joint_id":5,"temperature_c":85.3,"limit_c":80}
  ```

### 重力补偿

老化执行时，MIT 电机固件接收的控制律为：

```
τ = kp·(θ_target − θ_actual) + kd·θ̇ + τ_ff
```

当 `τ_ff = 0` 时，机械臂必须靠位置误差 `kp·(θ_target − θ_actual)` 产生对抗重力
的力矩，导致稳态下垂（sag）。重力补偿通过 URDF 模型计算各关节重力矩，将其作为
`τ_ff` 发送给电机，从而消除位置误差。

**实现**：`gravity.py` 使用 URDF 中提取的连杆质量、质心、关节几何，通过递归牛顿-
欧拉反向递推（仅重力项，无科氏力/惯性力）计算重力矩向量。纯 Python + numpy，无
外部依赖。

**启用**（默认关闭，fail-closed）：

```dotenv
REBOT_GRAVITY_COMPENSATION_ENABLE=1
```

**调优**：J2（肩部）和 J3（肘部）最可能需要调整补偿因子：

```dotenv
REBOT_GRAVITY_COMPENSATION_FACTOR=1,1.2,1.1,1,1,1,1
```

如果关节仍然下垂 → 增大对应因子；如果向反方向漂移 → 减小因子。
完全关闭 → 设为 `0`。

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

# 4. Jetson：初始化 CAN（PCAN-USB，需 sudo；脚本自动定位 PCAN 接口）
sudo $BASE/bin/rebotarm-can-init.sh 1000000
#    输出 "检测到 PCAN SocketCAN 接口: canX"，把 canX 填到 env 的 REBOT_CAN_CHANNEL

# 5. 启动 / 健康检查 / 停止
$BASE/bin/rebotarm-start.sh
$BASE/bin/rebotarm-health.sh
$BASE/bin/rebotarm-stop.sh
```

### 方式 B：OTA 远程更新（推荐日常升级）
```bash
# 在 UI 顶栏点击 🔄 按钮 → 检查更新 → 立即更新
# 后端自动从 GitHub Releases 下载最新版本并安装，显示进度条
# 更新完成后自动刷新页面
```

### 方式 C：源码一键部署（Jetson 上已有源码）
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

# 回零校验
REBOT_HOME_VERIFY_MODE=warn          # warn（默认，仅警告）| stop（终止老化）
REBOT_HOME_TOLERANCE_RAD=0.08        # 回零容差（rad），默认 0.08 ≈ 4.6°

REBOT_HOST=127.0.0.1
REBOT_PORT=8000
REBOT_LOG_JSON=1
REBOT_LOG_LEVEL=INFO
```

- `REBOT_AGING_LOG_ROOT` 由启动脚本固定为 `$BASE/log`；`REBOT_TRAJECTORY_DIR` 固定为
  `$BASE/Trajectory`，均不由 UI 选择。
- `REBOTARM_BASE` 由 `rebotarm-start.sh` 自动导出，OTA 版本识别依赖此环境变量。
- MIT 增益可选：`REBOT_MIT_KP=50,150,150,50,50,50,50`、`REBOT_MIT_KD=3,10,10,5,4,4,4`。
- 重力补偿可选（默认关闭）：`REBOT_GRAVITY_COMPENSATION_ENABLE=1`、补偿因子
  `REBOT_GRAVITY_COMPENSATION_FACTOR=1,1,1,1,1,1,1`（J1..J7）。
- 门禁为 `1` 只表示对应接口在用户确认后可调用，服务启动不自动扫描/使能/回零/动作。

## CAN 接口（PCAN-USB）

SocketCAN 接口名**不固定**：Jetson 板载 CAN（`mttcan`、`mcp251xfd`）会占用一部分
接口名，PCAN-USB 的具体名字取决于 USB 枚举顺序（常见 `can0/can1/can2`），插拔或
重载驱动后可能变化。**不要写死为 can1**。

三步配置：

```bash
# 1. 初始化 CAN，并读出 PCAN 实际接口名
sudo $BASE/bin/rebotarm-can-init.sh 1000000
#    输出: "检测到 PCAN SocketCAN 接口: canX"（X 以实际为准）

# 2. 把 env 的 REBOT_CAN_CHANNEL 设为该接口名
sed -i "s/^REBOT_CAN_CHANNEL=.*/REBOT_CAN_CHANNEL=canX/" $BASE/shared/env/rebotarm.env

# 3. 重启服务生效
$BASE/bin/rebotarm-stop.sh && $BASE/bin/rebotarm-start.sh
```

`rebotarm-can-init.sh` 会遍历 `/sys/class/net/can*` 找出驱动为 `pcan` 的接口
（自动跳过板载 `mttcan`/`mcp251xfd`），并用 1 Mbps 拉起。若找不到 pcan 接口，说明
PCAN 驱动未以 SocketCAN 模式编译（需 `make NET=NETDEV_SUPPORT` 重新编译
`peak-linux-driver`），见 `deploy/jetson/SOURCE_DEPLOYMENT.md` 第 4 节。

## 老化循环与日志

点击「启动老化」并确认后，后端把动作与日志作为同一生命周期启动：

```text
首次回零 → 平滑定位到动作起点 → processed 轨迹（MIT）
→ 回零 → 回零校验 → 间隔 → 再次回零校验 → 下一轮
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
| GET | `/api/ota/check` | OTA 检查更新（对比 GitHub Releases） |
| POST | `/api/ota/update-from-github` | OTA 从 GitHub 下载并安装 |
| GET | `/api/ota/progress` | OTA 安装进度追踪 |
| GET | `/api/ota/status` | 当前版本与部署信息 |

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
- PCAN 接口不存在或未 UP：跑 `sudo $BASE/bin/rebotarm-can-init.sh 1000000` 看检测输出；
  再核对 env 的 `REBOT_CAN_CHANNEL` 是否等于检测到的接口名。
- 服务重启后未连接：UI 中操作者重新扫描（初始 `disconnected` 是预期）。
- 老化按钮不可用：确认完整连接、新鲜真机遥测、`REBOT_ALLOW_AGING_WRITE=1`、Trajectory 有动作。
- 老化报 `home verification failed`：机械臂仍应在零位附近，通常是 MIT 稳态残差；
  `REBOT_HOME_VERIFY_MODE=warn` 时仅警告不中断，`stop` 时终止老化。可核对 `log` 遥测。
- 页面停顿：确认 WebSocket 持续收到真实遥测。
- 服务无法启动：看 `shared/logs/server.out`，不要用 kill 代替 `rebotarm-stop.sh`。
- OTA 版本显示为 "—"：确认 `rebotarm-start.sh` 已导出 `REBOTARM_BASE` 环境变量；
  更新到最新 release 后自动修复。

## 参考工程

`reBotArm_control` 是独立参考工程（动作/控制的最初实现），不属于本仓库；本仓库不
引用、不修改、不包含其文件。