/* 管理当前网页的工程自动保存和可移植工程文件。 */
(() => {
    "use strict";

    /* 浏览器工程数据库名。 */
    const databaseName = "image-to-bin";
    /* 保存当前工程的对象仓库名。 */
    const storeName = "projects";
    /* 按网页路径定位工程，忽略查询参数和片段。 */
    const projectKey = globalThis.location.pathname;
    /* 输出目录句柄使用独立键，避免把浏览器授权写进工程文件。 */
    const outputDirectoryKey = [projectKey, "output-directory"];
    /* 可移植工程文件的格式标识。 */
    const projectFormat = "image-to-bin-project";
    /* 工程数据格式版本。 */
    const projectVersion = 1;
    /* 按调用顺序提交自动保存，避免旧快照覆盖新快照。 */
    let pendingWrite = Promise.resolve();

    /* 打开本地数据库，首次运行时建立工程对象仓库。 */
    function openDatabase() {
        return new Promise((resolve, reject) => {
            /* 浏览器本地数据库接口。 */
            const databaseFactory = globalThis.indexedDB;
            if (!databaseFactory) {
                reject(new Error("当前浏览器无法使用工程自动保存。"));
                return;
            }

            /* 数据库打开请求。 */
            const request = databaseFactory.open(databaseName, 1);
            /* 记录请求已因其他页面占用而向调用方报错。 */
            let blocked = false;
            /* 初始化工程对象仓库。 */
            request.onupgradeneeded = () => {
                request.result.createObjectStore(storeName);
            };
            /* 在旧连接阻塞升级时立即反馈。 */
            request.onblocked = () => {
                blocked = true;
                reject(new Error("工程存储被其他页面占用，请关闭旧页面后重试。"));
            };
            /* 返回数据库访问失败的具体原因。 */
            request.onerror = () => reject(request.error);
            /* 打开成功后释放已报错的连接，允许其他页面升级。 */
            request.onsuccess = () => {
                /* 本次打开的数据库连接。 */
                const database = request.result;
                if (blocked) {
                    database.close();
                    return;
                }
                /* 其他网页升级数据库时释放当前连接。 */
                database.onversionchange = () => database.close();
                resolve(database);
            };
        });
    }

    /* 以 mode 指定的模式运行 operation，等待整个事务提交后再返回。 */
    async function runTransaction(mode, operation) {
        /* 本次事务使用的数据库连接。 */
        const database = await openDatabase();
        try {
            return await new Promise((resolve, reject) => {
                /* 工程对象仓库的读或写事务。 */
                const transaction = database.transaction(storeName, mode);
                /* 工程记录读写请求。 */
                const request = operation(transaction.objectStore(storeName));
                /* 事务提交后才报告成功。 */
                transaction.oncomplete = () => resolve(request.result);
                /* 读取具体错误，包括磁盘空间或存储配额不足。 */
                transaction.onabort = () => reject(transaction.error ?? new Error("工程存储事务已中止。"));
            });
        } finally {
            database.close();
        }
    }

    /* 按调用顺序执行 operation，单次写入失败后允许后续保存重试。 */
    function enqueueWrite(operation) {
        /* 本次事务完成后才报告保存结果。 */
        const write = pendingWrite.then(() => runTransaction("readwrite", operation));
        pendingWrite = write.catch(() => {});
        return write;
    }

    /* 判断 value 是否为工程数据所使用的普通对象。 */
    function isRecord(value) {
        return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
    }

    /* 读取 image 资源的原始文件并复制工程资源公共字段。 */
    function copyItem(item, index) {
        /* 可直接定位工程资源的错误。 */
        const itemError = new Error(`工程第 ${index + 1} 项的资源配置无效。`);
        if (!isRecord(item) || typeof item.id !== "string" || !item.id || typeof item.name !== "string" || typeof item.address !== "string" || (item.enabled !== undefined && typeof item.enabled !== "boolean")) {
            throw itemError;
        }

        /* 统一保存资源的公共配置，未设置启用状态时沿用启用默认值。 */
        const common = {id: item.id, kind: item.kind, name: item.name, address: item.address, enabled: item.enabled ?? true};
        if (item.kind === "reserved" && typeof item.length === "string" && typeof item.fill === "string") {
            return {...common, length: item.length, fill: item.fill};
        }

        if (item.kind === "image" && typeof item.sourceName === "string" && Number.isSafeInteger(item.width) && item.width > 0 && Number.isSafeInteger(item.height) && item.height > 0 && item.file instanceof Blob && item.file.size > 0) {
            return {...common, sourceName: item.sourceName, width: item.width, height: item.height, file: item.file};
        }
        throw itemError;
    }

    /* 验证并复制 project 的设置和资源，保留用户尚未填完的表单内容。 */
    function snapshotProject(project) {
        if (!isRecord(project) || !isRecord(project.settings) || !Array.isArray(project.items)) {
            throw new Error("工程缺少设置或资源列表。");
        }

        /* 可安全复制的工程设置项。 */
        const settings = {};
        /* key 为设置名，value 为当前表单值。 */
        for (const [key, value] of Object.entries(project.settings)) {
            if (Object.hasOwn(Object.prototype, key) || key === "prototype" || (typeof value !== "string" && typeof value !== "boolean")) {
                throw new Error(`工程设置「${key}」无效。`);
            }
            settings[key] = value;
        }

        /* 验证并复制后的资源，按工程存储顺序排列。 */
        const items = project.items.map(copyItem);
        /* 用于检查资源 ID 是否重复的集合。 */
        const itemIds = new Set(items.map((item) => item.id));
        if (itemIds.size !== items.length) {
            throw new Error("工程含有重复的资源 ID。");
        }
        return {settings, items};
    }

    /* 检查 record 的标识和版本，便于识别旧桌面工具的工程文件。 */
    function validateFormat(record) {
        if (!isRecord(record) || record.format !== projectFormat || record.version !== projectVersion) {
            throw new Error("无法识别工程格式或版本，请使用本工具保存的 .itbproj 文件。");
        }
    }

    /* 读取当前网页上一次提交的工程，空工程记录返回 null。 */
    async function load() {
        await pendingWrite;
        /* 浏览器本地保存的工程记录。 */
        const record = await runTransaction("readonly", (store) => store.get(projectKey));
        if (record === undefined) {
            return null;
        }
        validateFormat(record);
        return snapshotProject(record);
    }

    /* 保存 project 的当前快照，图片以原始 Blob 写入浏览器本地数据库。 */
    async function save(project) {
        /* 本次调用独立持有的工程快照。 */
        const record = {format: projectFormat, version: projectVersion, ...snapshotProject(project)};
        await enqueueWrite((store) => store.put(record, projectKey));
    }

    /* 检查 value 是否为当前浏览器可用的原生目录句柄。 */
    function isDirectoryHandle(value) {
        return typeof globalThis.FileSystemDirectoryHandle === "function" && value instanceof globalThis.FileSystemDirectoryHandle;
    }

    /* 读取上次选择的输出目录，交由调用方检查使用权限。 */
    async function loadOutputDirectory() {
        await pendingWrite;
        /* 当前网页保存的本地输出目录句柄。 */
        const handle = await runTransaction("readonly", (store) => store.get(outputDirectoryKey));
        return isDirectoryHandle(handle) ? handle : null;
    }

    /* 将 handle 作为当前网页的输出目录保存到浏览器本地数据库。 */
    async function saveOutputDirectory(handle) {
        if (!isDirectoryHandle(handle)) {
            throw new TypeError("输出目录句柄无效。");
        }
        await enqueueWrite((store) => store.put(handle, outputDirectoryKey));
    }

    /* 将 file 中的原始图片字节编码为 Base64 文本。 */
    function encodeFile(file) {
        return new Promise((resolve, reject) => {
            /* 浏览器原生文件读取器。 */
            const reader = new FileReader();
            /* 剥离数据 URL 的媒体类型和 Base64 标记。 */
            reader.onload = () => resolve(reader.result.split(";base64,").at(-1));
            /* 反馈图片读取错误。 */
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
        });
    }

    /* 解码 source 中的原始图片字节，index 用于报告出错的资源位置。 */
    function decodeFile(source, index) {
        if (!isRecord(source) || typeof source.type !== "string" || typeof source.data !== "string" || !source.data) {
            throw new Error(`工程第 ${index + 1} 项缺少原始图片数据。`);
        }

        try {
            if (typeof Uint8Array.fromBase64 === "function") {
                return new Blob([Uint8Array.fromBase64(source.data)], {type: source.type});
            }
            /* 兼容未提供原生字节数组 Base64 接口的浏览器。 */
            const binary = atob(source.data);
            /* 还原后的原始图片字节。 */
            const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
            return new Blob([bytes], {type: source.type});
        } catch (error) {
            throw new Error(`工程第 ${index + 1} 项的图片数据无法解析。`, {cause: error});
        }
    }

    /* 将 project 打包为包含原始图片的可移植工程文件。 */
    async function exportFile(project) {
        /* 导出的自包含工程记录。 */
        const record = {format: projectFormat, version: projectVersion, ...snapshotProject(project)};
        /* item 为当前待打包的资源。 */
        for (const item of record.items) {
            if (item.kind === "image") {
                item.file = {type: item.file.type, data: await encodeFile(item.file)};
            }
        }
        return new Blob([JSON.stringify(record)], {type: "application/json"});
    }

    /* 读取网页保存的工程 file，工程整体通过校验后再返回。 */
    async function importFile(file) {
        /* 从便携工程文件读取的记录。 */
        let record = null;
        try {
            record = JSON.parse(await file.text());
        } catch (error) {
            throw new Error("工程文件无法读取，请检查文件内容。", {cause: error});
        }

        validateFormat(record);
        if (!Array.isArray(record.items)) {
            throw new Error("工程缺少资源列表。");
        }

        /* 解码文件中的图片资源，保留原始资源顺序。 */
        const items = record.items.map((item, index) => {
            if (isRecord(item) && item.kind === "image") {
                return {...item, file: decodeFile(item.file, index)};
            }
            return item;
        });
        return snapshotProject({settings: record.settings, items});
    }

    globalThis.ProjectStorage = Object.freeze({load, save, exportFile, importFile, loadOutputDirectory, saveOutputDirectory});
})();
