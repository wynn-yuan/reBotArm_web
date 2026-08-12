#!/bin/sh
# rebotarm-can-init.sh — 检测 PCAN-USB 并初始化 CAN 接口。
#
# 目的: 在 reBotArm 部署机上检测 Peak PCAN-USB 设备、加载内核驱动、
#       配置并拉起 SocketCAN 接口(can0/can1),供 motorbridge 适配器使用。
#
# 需要 sudo(ip link / 内核模块)。普通用户运行会自动提示密码。
# 用法:
#   sudo sh rebotarm-can-init.sh [canN] [bitrate]
#   默认: can1, 1000000(1 Mbps)
#
# 退出码:
#   0 = CAN 已就绪; 1 = 未检测到 PCAN / 驱动加载失败; 2 = 接口未出现 / 配置失败。

set -eu

CAN="${1:-can1}"
BITRATE="${2:-1000000}"

echo "== [1/4] 检测 PCAN-USB 设备 =="
if command -v lsusb >/dev/null 2>&1; then
  if lsusb 2>/dev/null | grep -qiE "Peak System|PCAN"; then
    lsusb | grep -iE "Peak System|PCAN"
    echo "  -> PCAN-USB 已检测到"
  else
    echo "!! 警告: USB 总线上未找到 Peak System/PCAN 设备(仍将尝试初始化)"
  fi
else
  echo "!! 警告: 无 lsusb,跳过 USB 设备检测"
fi

echo
echo "== [2/4] 加载 CAN 内核驱动 (pcan / peak_usb) =="
DRIVER_LOADED=0
if lsmod 2>/dev/null | grep -qE '^(pcan|peak_usb)'; then
  echo "  -> CAN 驱动已加载"
  DRIVER_LOADED=1
else
  for mod in pcan peak_usb; do
    if sudo modprobe "$mod" 2>/dev/null; then
      echo "  -> $mod 已通过 modprobe 加载"
      DRIVER_LOADED=1
      break
    fi
  done
  if [ "$DRIVER_LOADED" -ne 1 ]; then
    # 兜底: 常见路径 insmod (peak-linux-driver 9.2.0 聚合模块 pcan.ko)
    for ko in \
      "/lib/modules/$(uname -r)/misc/pcan.ko" \
      "/lib/modules/$(uname -r)/kernel/drivers/net/can/peak_usb/peak_usb.ko"
    do
      if [ -f "$ko" ] && sudo insmod "$ko" 2>/dev/null; then
        echo "  -> 已 insmod $ko"
        DRIVER_LOADED=1
        break
      fi
    done
  fi
  if [ "$DRIVER_LOADED" -ne 1 ]; then
    echo "ERROR: 无法加载 pcan/peak_usb 驱动(PCAN-USB 无法工作)"
    echo "提示: 从 within.peak-system.com 获取 peak-linux-driver 并 make install。"
    exit 1
  fi
fi
sleep 2

echo
echo "== [3/4] 定位 PCAN-USB 的 SocketCAN 接口 =="
# 自动找到由 pcan 内核驱动创建的接口(PCAN-USB);若存在则覆盖命令行指定的 $CAN。
# 板载 mttcan / mcp251xfd 接口不会匹配,避免把电机误配到错误的总线。
PCAN_IF=""
for iface in /sys/class/net/can*; do
  [ -e "$iface/device/driver" ] || continue
  drv=$(basename "$(readlink -f "$iface/device/driver")" 2>/dev/null)
  if [ "$drv" = "pcan" ]; then
    PCAN_IF=$(basename "$iface")
    break
  fi
done
if [ -n "$PCAN_IF" ]; then
  echo "  -> 检测到 PCAN SocketCAN 接口: $PCAN_IF"
  CAN="$PCAN_IF"
else
  echo "  -> 未找到 pcan 驱动接口,使用命令行指定: $CAN"
fi

echo "  -> 等待接口 \"$CAN\" 出现..."
found=0
i=0
while [ "$i" -lt 10 ]; do
  if ip link show "$CAN" >/dev/null 2>&1; then found=1; break; fi
  i=$((i + 1))
  sleep 1
done
if [ "$found" -ne 1 ]; then
  echo "ERROR: 未找到 $CAN 接口。当前可用 CAN 接口:"
  ip -o link show 2>/dev/null | grep -i 'can' || echo "  (无)"
  exit 2
fi
echo "  -> 找到 $CAN"

echo
echo "== [4/4] 配置 bitrate=$BITRATE 并 up =="
sudo ip link set "$CAN" down 2>/dev/null || true
sudo ip link set "$CAN" up type can bitrate "$BITRATE"
ip -details link show "$CAN"
echo
echo "OK: $CAN 已就绪(bitrate $BITRATE)。"
echo "下一步: 以普通用户启动服务 -> $0 所在目录/rebotarm-start.sh"