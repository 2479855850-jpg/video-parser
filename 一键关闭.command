#!/bin/bash
# 关闭脚本：查找并关闭服务

# 切换到脚本所在目录
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR" || exit

echo "--- 正在关闭服务 ---"

# 通过端口检查服务
PID=$(lsof -ti:3003)

if [ -z "$PID" ]; then
    echo "🤷‍♂️ 服务当前未在运行。"
    exit 0
fi

echo "找到服务进程 PID: $PID，正在关闭..."
# 使用 kill -9 强制确保进程被关闭
kill -9 $PID
echo "🛑 服务已关闭。"
exit 0
