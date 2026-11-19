"use strict";

/* 应用资源版本。发布任何预缓存资源的更新时同步递增此值。 */
const cacheVersion = "v1";
/* Service Worker 所在部署目录的 URL。 */
const appScope = self.registration.scope;
/* 缓存名称以部署目录区分，避免影响同源其他部署。 */
const cachePrefix = "image-to-bin:" + appScope + ":";
/* 保存本版本全部应用资源的缓存名称。 */
const cacheName = cachePrefix + cacheVersion;
/* 工具主页的实际文件路径。 */
const indexUrl = appScope + "index.html";
/* 工具离线启动所需的完整资源清单。 */
const appFiles = [
    indexUrl,
    appScope + "styles.css",
    appScope + "image-converter.js",
    appScope + "project-storage.js",
    appScope + "zip-export.js",
    appScope + "app.js",
    appScope + "manifest.webmanifest",
    appScope + "icons/icon-192.png",
    appScope + "icons/icon-512.png"
];

/* 为 url 创建安装请求，绕过浏览器 HTTP 缓存以下载当前发布的资源。 */
function createInstallRequest(url) {
    return new Request(url, {cache: "reload"});
}

/* 一次写入完整资源清单，任一文件下载失败时保留当前运行的版本。 */
async function cacheAppFiles() {
    /* 新版本的离线缓存。 */
    const cache = await caches.open(cacheName);
    await cache.addAll(appFiles.map(createInstallRequest));
}

/* 在旧窗口继续使用旧版本时等待其关闭，由 event 等待新资源缓存完成。 */
function installApp(event) {
    event.waitUntil(cacheAppFiles());
}

/* 新版本接管后，删除本部署目录的旧资源缓存。 */
async function removeOldCaches() {
    /* 当前源下的所有缓存名称。 */
    const keys = await caches.keys();
    /* 逐一检查键名是否属于本部署目录。 */
    for (const key of keys) {
        if (key.startsWith(cachePrefix) && key !== cacheName) {
            await caches.delete(key);
        }
    }
}

/* 由 event 等待旧资源缓存清理完成。 */
function activateApp(event) {
    event.waitUntil(removeOldCaches());
}

/* 查找 cacheUrl 对应的资源，缓存缺失时发送原始 request。 */
async function readAppFile(cacheUrl, request) {
    /* 本版本中与路径匹配的缓存响应。 */
    const response = await caches.match(cacheUrl, {cacheName});
    return response || fetch(request);
}

/* 按 event 的请求路径返回本版本的资源，主页的入口目录与文件共用同一缓存。 */
function serveAppFile(event) {
    /* 浏览器发出的原始请求。 */
    const request = event.request;
    if (request.method !== "GET") {
        return;
    }

    if (request.mode === "navigate") {
        /* 去掉查询参数后的导航目标，用于匹配已预缓存的主页。 */
        const url = new URL(request.url);
        url.search = "";
        if (url.href === appScope || url.href === indexUrl) {
            event.respondWith(readAppFile(indexUrl, request));
        }
        return;
    }

    if (appFiles.includes(request.url)) {
        event.respondWith(readAppFile(request.url, request));
    }
}

self.addEventListener("install", installApp);
self.addEventListener("activate", activateApp);
self.addEventListener("fetch", serveAppFile);
