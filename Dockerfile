# Runtime image for the lean EC2 test deployment (infra/lean, SDD.md changelog
# #017). Not multi-stage: this deliberately keeps devDependencies (tsx) in the
# final image so the container's own startup command can run migrations
# before serving -- see docker-compose.yml's `command`. Not used by the
# production Terraform composition in infra/main.tf, which has no built image
# yet (see infra/README.md).
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV PORT=3000
EXPOSE 3000

CMD ["node", "dist/index.js"]
