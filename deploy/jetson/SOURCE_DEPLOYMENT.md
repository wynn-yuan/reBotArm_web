# reBotArm Web：Jetson 部署指南

本指南用于在 **Jetson** 上部署 reBotArm Web（后端 + 前端 + Trajectory 动作库 +
老化 MIT 执行）。真实部署为**用户态、版本化 release + 原子切换 + 回滚**，不使用
Docker、nginx、systemd。部署过程不会自动扫描、使能、回零或执行机械臂动作。

---

## 1. 目录约定

源码与运行目录必须分开：

```text
/home/<user>/rebotarm-src/reBotArm_web   # 源码、Node 依赖、构建产物
/home/<user>/rebotarm-web                # 正式运行目录（由部署脚本管理）
```

运行目录结构（由 `install_release.sh` 创建）：

```text
/home/<user>/rebotarm-web/
├── releases/<release-id>/          # 每个版本一个目录
├── current -> releases/<release-id>  # 原子 symlink 切换
├── shared/env/rebotarm.env         # 现场配置（权限 600，install 不覆盖）
├── shared/logs/                    # server.out、rebotarm.pid
├── shared/venv/                    # Python 3.10 venv（跨版本复用）
├── log/                            # 老化遥测 CSV（启动脚本固定）
├── Trajectory/                     # 动作库（启动脚本固定，与 log 同级）
└── bin/                            # rebotarm-{can-init,start,stop,health}.sh
```

---

## 2. 首次安装系统依赖

以下命令涉及 `sudo`，只安装构建工具与配置 CAN；Web 服务本身始终以普通用户运行。

```bash
sudo apt-get update
sudo apt-get install -y curl tar python3.10 python3.10-venv can-utils usbutils

python3.10 --version
node --version
npm --version

# 锁文件要求 Node >=20.19 或 >=22.12
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit((a===20&&b>=19)||(a===22&&b>=12)||a>22?0:1)'
```

Node 版本不满足时，请通过团队认可的源或官方 ARM64 包安装，不要用 `apt install nodejs`。

---

## 3. 一次完整的部署

### 方式 A：开发机打包，Jetson 安装（推荐）

在**开发机**（有源码与已构建的 `apps/web/dist`）打包：

```bash
sh deploy/jetson/make_release.sh "20260812-<id>"
# 产物: deploy/jetson/out/rebotarm-release-<id>.tar.gz
```

上传并在 **Jetson** 安装：

```bash
scp deploy/jetson/out/rebotarm-release-<id>.tar.gz <user>@<host>:~/rebotarm-install/
ssh <user>@<host> "sh ~/rebotarm-install/install_release.sh ~/rebotarm-install/rebotarm-release-<id>.tar.gz"
```

`install_release.sh`：校验 tarball → 解压 → 创建/复用 venv → 装 rebot-server（含
motorbridge 0.5.1 固定）→ **保留现有 env** → 原子切换 `current` → 更新 `bin` 脚本。

### 方式 B：源码一键部署（Jetson 上已有源码）

```bash
cd /home/<user>/rebotarm-src/reBotArm_web
sh deploy.sh                              # 构建+测试+打包+安装+健康检查，失败自动回滚
sh deploy.sh --release-id my-id --base /home/<user>/rebotarm-web
```

---

## 4. 初始化 CAN（PCAN-USB）

`rebotarm-can-init.sh` 检测 PCAN-USB、加载驱动、**自动定位 PCAN 对应的 SocketCAN 接口**
（驱动名为 `pcan` 的那个，板载 mttcan/mcp251xfd 不会被误配），并用 1M 比特率拉起：

```bash
sudo /home/<user>/rebotarm-web/bin/rebotarm-can-init.sh 1000000
```

脚本步骤：
1. `lsusb` 检测 Peak System / PCAN 设备；
2. 加载驱动：`modprobe pcan`（或 `peak_usb`），失败则 `insmod` 常见路径；
3. 遍历 `/sys/class/net/can*` 找出 `driver == pcan` 的接口（如 `can2`）；
4. `ip link set <iface> up type can bitrate 1000000` 并 `ip -details` 核对。

**PCAN 驱动以 SocketCAN 模式编译**：PEAK `peak-linux-driver` 默认只编译字符设备
（`/dev/pcan*`），motorbridge 需要 SocketCAN 接口。若 `can-init` 找不到 pcan 接口，
用以下方式重新编译驱动（源码通常已在 `~/peak-linux-driver-<ver>`）：

```bash
cd ~/peak-linux-driver-<ver>/driver
make clean
make NET=NETDEV_SUPPORT
sudo make install
sudo modprobe -r pcan 2>/dev/null; sudo modprobe pcan
```

**然后**把 env 的 `REBOT_CAN_CHANNEL` 设为 can-init 输出的接口名（不要把
`REBOT_CAN_CHANNEL` 写死为 can1，板载 CAN 可能占用 can0/can1）。

---

## 5. 运行配置

```bash
nano /home/<user>/rebotarm-web/shared/env/rebotarm.env
```

Jetson + PCAN-USB `can1` 的确认配置：

```dotenv
REBOT_ADAPTER=motorbridge
REBOT_CAN_CHANNEL=can1
REBOT_HOST_ID=0xFD
REBOT_PING_TIMEOUT_MS=500
REBOT_TELEMETRY_HZ=10

REBOT_ALLOW_ACTIVE_REPORT_WRITE=1
REBOT_ALLOW_ENABLE_WRITE=1
REBOT_ALLOW_PARAMETER_WRITE=1
REBOT_ALLOW_SET_ZERO_WRITE=1
REBOT_ALLOW_ZERO_TORQUE_WRITE=1
REBOT_ZERO_TORQUE_HZ=50
REBOT_ALLOW_AGING_WRITE=1

REBOT_HOST=127.0.0.1
REBOT_PORT=8000
REBOT_LOG_JSON=1
REBOT_LOG_LEVEL=INFO

# 可选：MIT 位置伺服增益（J1..J6 + 夹爪，7 个值，正有限数）
# REBOT_MIT_KP=50,150,150,50,50,50,50
# REBOT_MIT_KD=3,10,10,5,4,4,4
```

- `REBOT_AGING_LOG_ROOT` 与 `REBOT_TRAJECTORY_DIR` 由 `rebotarm-start.sh` 固定为
  `$BASE/log` 与 `$BASE/Trajectory`，不由 UI 或 env 选择。
- 权限必须为 600：`chmod 600 .../rebotarm.env`。
- 门禁为 `1` 只表示接口在用户确认后可调用；服务启动不自动动作。

---

## 6. 启动 / 健康检查 / 访问

```bash
BASE=/home/<user>/rebotarm-web
"$BASE/bin/rebotarm-start.sh"
"$BASE/bin/rebotarm-health.sh"
curl -fsS http://127.0.0.1:8000/api/health
curl -fsS http://127.0.0.1:8000/api/aging/logs
readlink "$BASE/current"
```

预期：
- health：`status=ok`、`adapter=motorbridge`、`channel=can1`、`motorbridge=0.5.1`；
- 服务刚启动连接为 `disconnected`（操作者需在 UI 扫描）；
- `/api/aging/logs` 的 `aging_execution_available=true`；
- `current` 指向本次新 release。

浏览器访问（Jetson 本机）：

```text
http://127.0.0.1:8000/
```

远程维护用 SSH 隧道（不要把服务改成 `0.0.0.0`）：

```bash
ssh -L 8000:127.0.0.1:8000 <user>@<host>
```

升级后浏览器 `Ctrl+F5` 强刷。

---

## 7. 日常升级

每次使用新 release ID（同一 ID 安装器会拒绝覆盖）：

```bash
# 方式 A：开发机打包 → Jetson 安装
sh deploy/jetson/make_release.sh "20260813-<id>"
scp deploy/jetson/out/rebotarm-release-<id>.tar.gz <user>@<host>:~/rebotarm-install/
ssh <user>@<host> "
  /home/<user>/rebotarm-web/bin/rebotarm-stop.sh
  sh ~/rebotarm-install/install_release.sh ~/rebotarm-install/rebotarm-release-<id>.tar.gz
  /home/<user>/rebotarm-web/bin/rebotarm-start.sh
  /home/<user>/rebotarm-web/bin/rebotarm-health.sh"
```

`install_release.sh` 保留现有 `rebotarm.env`，不会用模板覆盖现场配置。

---

## 8. 回滚

```bash
BASE=/home/<user>/rebotarm-web
ls -1 "$BASE/releases"
readlink "$BASE/current"
```

确认老化和零力矩均未运行后：

```bash
OLD='<old-release-id>'
"$BASE/bin/rebotarm-stop.sh"
"$BASE/shared/venv/bin/python" -m pip install --disable-pip-version-check --quiet "$BASE/releases/$OLD/server"
install -m 755 "$BASE/releases/$OLD/scripts/rebotarm-start.sh" "$BASE/bin/rebotarm-start.sh"
install -m 755 "$BASE/releases/$OLD/scripts/rebotarm-stop.sh"  "$BASE/bin/rebotarm-stop.sh"
install -m 755 "$BASE/releases/$OLD/scripts/rebotarm-health.sh" "$BASE/bin/rebotarm-health.sh"
ln -sfn "releases/$OLD" "$BASE/current.new" && mv -Tf "$BASE/current.new" "$BASE/current"
"$BASE/bin/rebotarm-start.sh"
"$BASE/bin/rebotarm-health.sh"
```

回滚不覆盖 `shared/env`、`log`、`Trajectory`。

---

## 9. 故障检查

```bash
BASE=/home/<user>/rebotarm-web
tail -n 200 "$BASE/shared/logs/server.out"
df -h "$BASE/log"
```

- Node 版本不足：升级后重新 `npm ci` 与构建。
- motorbridge 不是 0.5.1：服务 fail closed，不跳过版本门。
- `can1` 不存在或未 UP：`sudo "$BASE/bin/rebotarm-can-init.sh" can1 1000000`。
- 老化按钮不可用：检查完整连接、新鲜真机遥测、`REBOT_ALLOW_AGING_WRITE=1`、Trajectory 有动作。
- 老化报 `home verification failed`：核对 `$BASE/log` 遥测位置，通常是 MIT 稳态残差。
- 页面仍是旧版：`Ctrl+F5`。
- 服务重启后未连接：操作者重新扫描（预期行为）。
- 端口不可达：服务只绑 `127.0.0.1`，本机或 SSH 隧道访问。

---

## 10. 停止服务

```bash
/home/<user>/rebotarm-web/bin/rebotarm-stop.sh
```

若老化或零力矩正在运行，正常关闭会先做受控清理（回零验证并失能）；现场必须有人
监护。不要通过直接杀进程代替正常停止脚本。