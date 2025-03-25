FROM node:14-alpine as build
ARG ENVIRONMENT="live"
WORKDIR /usr/local/app

# Copy package files first to leverage caching for npm install
COPY package*.json ./
RUN npm install

# Copy application code except environments
COPY . ./
RUN rm -rf ./src/environments

# Copy the specific environment file last
# This ensures that changing only environment files doesn't invalidate previous layers
COPY ./src/environments ./src/environments/

# Build the application
RUN npm run build:${ENVIRONMENT}

FROM nginx:alpine
COPY --from=build /usr/local/app/dist/nano-vote-visualizer /usr/share/nginx/html
EXPOSE 80