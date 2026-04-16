#!/bin/bash
# 重启脚本：先关闭，再启动

# 切换到脚本所在目录
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR" || exit

echo "--- 正在重启服务 ---"

# 执行关闭脚本
sh ./一键关闭.command

# 短暂等待，确保端口释放
sleep 1

# 执行启动脚本
sh ./一键启动.command

echo "
--- ✅ 重启完成 ---"
exit 0
