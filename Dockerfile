# KARDS Web —— 生产镜像（Node 20 + ws，无需编译依赖）
FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

# 先装依赖，利用镜像层缓存
COPY package*.json ./
RUN npm ci --omit=dev

# 再拷代码与静态资源（卡图约 96MB）
COPY . .

ENV PORT=8080
EXPOSE 8080

# 容器里用 0.0.0.0 监听，平台会自动注入 PORT
CMD ["node", "server/index.js"]
