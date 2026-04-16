#!/bin/bash
# 安全启动脚本：仅在服务未运行时启动

# 切换到脚本所在目录
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR" || exit

echo "--- 尝试启动服务 ---"

# 通过端口检查服务是否已在运行
PID=$(lsof -ti:3003)

if [ ! -z "$PID" ]; then
    echo "✅ 服务已在运行中 (PID: $PID)。无需重复启动。"
    exit 1
fi

echo "[1/2] 检查并安装依赖..."
npm install

echo "[2/2] 在后台启动服务..."
nohup npm start > server.log 2>&1 &

sleep 2
echo "🚀 服务启动成功！"
echo "   请访问: http://localhost:3003"
exit 0
