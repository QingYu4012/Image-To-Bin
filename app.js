/* 连接网页、图片取模、工程存储和文件导出。 */
(() => {
    'use strict';

    /* 图片编码和 Flash 规划接口。 */
    const converter = window.ImageConverter;
    /* 工程读写接口。 */
    const storage = window.ProjectStorage;
    /* 支持的主题以及系统当前的深色偏好。 */
    const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
    /* 页面各项设置控件，控件 ID 对应工程设置名。 */
    const settingInputs = [...document.querySelectorAll('[data-setting]')];
    /* 生成映射文件使用的固定文件名。 */
    const mapHeaderName = 'system_ui_images_map.h';
    /* 生成 CSV 使用的固定文件名。 */
    const mapCsvName = 'system_ui_images_map.csv';
    /* 浏览器是否允许选择并写入目录。 */
    const hasDirectoryPicker = typeof window.showDirectoryPicker === 'function';
    /* 目录中的图片按相对路径和自然数字顺序导入。 */
    const folderOrder = new Intl.Collator('zh-CN', {numeric: true});

    /* 根据控件 ID 读取页面元素。 */
    function element(id) {
        return document.getElementById(id);
    }

    /* 更新默认主题，打开工程时会再次应用已保存的主题。 */
    document.documentElement.dataset.theme = systemTheme.matches ? 'dark' : 'light';
    if (!converter || !storage || !window.ZipExport) {
        element('storage-status').textContent = '工具文件加载失败，请从完整项目目录打开 index.html。';
        element('storage-status').classList.add('error');
        return;
    }

    /* 默认设置保存为表单可直接还原的字符串和布尔值。 */
    const defaultSettings = {...converter.defaults, monoThreshold: String(converter.defaults.monoThreshold), theme: 'system'};
    /* 当前工程，包含设置、资源顺序和原始图片。 */
    let project = {settings: {...defaultSettings}, items: []};
    /* 当前设置与资源计算得到的 Flash 布局。 */
    let layout = null;
    /* 启动、图片读取和导出期间阻止工程被切换。 */
    let busy = true;
    /* 等待页面空闲后从系统启动请求中读取的工程文件句柄。 */
    const pendingLaunchFiles = [];
    /* 记录最新的自动保存请求，避免旧请求更新页面状态。 */
    let storageRevision = 0;
    /* 自动保存正在写入时合并后续输入，只提交最新工程快照。 */
    let saving = false;
    /* 当前资源使用的预览地址，图片移除后立即释放。 */
    const previews = new Map();
    /* 原图窗口的浏览顺序、图片位置和缩放状态。 */
    let previewSession = null;
    /* 勾选用于批量删除的资源 ID，与参与打包的开关独立。 */
    const selectedItems = new Set();
    /* 浏览器授权访问的当前输出目录。 */
    let outputDirectory = null;

    /* 把 entries 中的颜色、扫描或预设选项加入对应下拉框。 */
    function populate(id, entries) {
        /* 当前下拉框。 */
        const select = element(id);
        for (const entry of entries) {
            select.add(new Option(entry.label, entry.id));
        }
    }

    /* 应用工程中的主题设置，跟随系统时读取当前系统设置。 */
    function applyTheme() {
        /* 当前选择的主题模式。 */
        const mode = project.settings.theme;
        document.documentElement.dataset.theme = mode === 'system' ? (systemTheme.matches ? 'dark' : 'light') : mode;
    }

    /* 用 saved 恢复当前版本可识别的工程设置。 */
    function showSettings(saved) {
        for (const input of settingInputs) {
            /* 当前控件对应的工程字段。 */
            const key = input.id;
            /* 持久化文件中此字段的值。 */
            const value = saved[key];
            /* 缺失或类型不兼容时使用当前默认值。 */
            const candidate = typeof value === typeof defaultSettings[key] ? value : defaultSettings[key];
            if (input.type === 'checkbox') {
                input.checked = candidate;
                project.settings[key] = input.checked;
                continue;
            }
            input.value = candidate;
            if (input instanceof HTMLSelectElement && input.selectedIndex < 0) {
                input.value = defaultSettings[key];
            }
            project.settings[key] = input.value;
        }
        applyTheme();
    }

    /* 在界面显示 message，isError 控制异常标识。 */
    function status(message, isError = false) {
        /* 图片导入和导出共用的状态区域。 */
        const output = element('operation-status');
        output.textContent = message;
        output.hidden = !message;
        output.classList.toggle('error', isError);
    }

    /* 保存当前工程快照，事务完成后再更新自动保存提示。 */
    async function autosave() {
        storageRevision += 1;
        if (saving) {
            return;
        }
        saving = true;
        /* 本次保存请求编号。 */
        let revision = 0;
        /* 设置区的存储状态文字。 */
        const label = element('storage-status');
        label.textContent = '正在自动保存…';
        label.classList.remove('error');
        do {
            revision = storageRevision;
            try {
                await storage.save(project);
                if (revision === storageRevision) {
                    label.textContent = '已自动保存到此浏览器';
                }
            } catch {
                if (revision === storageRevision) {
                    label.textContent = '自动保存失败，可使用「保存工程」备份。';
                    label.classList.add('error');
                }
            }
        } while (revision !== storageRevision);
        saving = false;
    }

    /* 用适合页面显示的单位格式化 bytes，完整字节数在悬停时显示。 */
    function sizeText(bytes) {
        if (bytes == null) {
            return '—';
        }
        if (bytes < 1024) {
            return `${bytes} B`;
        }
        if (bytes < 1048576) {
            return `${Number((bytes / 1024).toFixed(2))} KiB`;
        }
        return `${Number((bytes / 1048576).toFixed(2))} MiB`;
    }

    /* 显示统计数据，同时保留 id 对应控件的精确字节数。 */
    function showSize(id, bytes) {
        /* 统计值放置的位置。 */
        const output = element(id);
        output.textContent = sizeText(bytes);
        output.title = bytes == null ? '' : `${bytes} B`;
    }

    /* 判断所选资源是否可沿 direction 移动一格，-1 表示上移，1 表示下移。 */
    function canMoveSelected(direction) {
        if (!selectedItems.size) {
            return false;
        }
        return project.items.some((item, index) => {
            /* 当前项在指定方向上的相邻资源。 */
            const neighbor = project.items[index + direction];
            return selectedItems.has(item.id) && neighbor !== undefined && !selectedItems.has(neighbor.id);
        });
    }

    /* 同步批量操作按钮，选择变化或工程忙碌状态变化时均调用。 */
    function syncBulkControls() {
        element('move-selected-up').disabled = busy || !canMoveSelected(-1);
        element('move-selected-down').disabled = busy || !canMoveSelected(1);
        element('delete-selected').disabled = busy || !selectedItems.size;
    }

    /* 根据设置和 busy 状态管理操作按钮。 */
    function syncControls() {
        for (const id of ['theme', 'open-project', 'import-images', 'import-directory', 'reserve', 'settings']) {
            element(id).disabled = busy;
        }
        element('choose-save-path').disabled = busy || !hasDirectoryPicker;
        /* 保存需要至少一项启用资源，且转换与地址校验均通过。 */
        const ready = !!layout?.activeCount && !layout.issues.length;
        element('save-project').disabled = busy || !ready;
        element('save-project').title = ready ? '' : '至少启用一项有效资源后可保存工程和烧录文件。';
        element('clear-resources').disabled = busy || !project.items.length;
        element('select-all').disabled = busy || !project.items.length;
        syncBulkControls();
        for (const control of element('resource-list').querySelectorAll('button, input')) {
            control.disabled = busy || control.dataset.atBoundary === 'true';
        }
    }

    /* 结束当前操作并继续处理等待打开的系统工程。 */
    function finishOperation() {
        busy = false;
        syncControls();
        openNextLaunchedProject();
    }

    /* 显示批量勾选状态，部分选中时将表头复选框设为半选。 */
    function syncSelection() {
        /* 表头中用于选择全部资源的复选框。 */
        const all = element('select-all');
        all.checked = selectedItems.size > 0 && selectedItems.size === project.items.length;
        all.indeterminate = selectedItems.size > 0 && selectedItems.size < project.items.length;
        element('selection-count').textContent = `已选 ${selectedItems.size} 项`;
        syncBulkControls();
        for (const row of element('resource-list').rows) {
            /* 当前行是否被勾选进行批量操作。 */
            const checked = selectedItems.has(row.dataset.id);
            row.querySelector('[data-select]').checked = checked;
            row.classList.toggle('selected', checked);
        }
    }

    /* 重新规划资源，刷新容量、验证信息和行内地址。 */
    function updateLayout() {
        layout = converter.plan(project.items, project.settings);
        element('mono-options').hidden = project.settings.format !== 'mono1';
        element('enabled-count').textContent = `${layout.activeCount} / ${project.items.length}`;
        showSize('payload-size', layout.payloadBytes);
        showSize('bin-size', layout.size);
        showSize('remaining-size', layout.remainingBytes);

        /* 有限容量时按 BIN 从地址 0 开始的实际长度计算使用比例。 */
        const percent = layout.capacity > 0 ? layout.size / layout.capacity * 100 : 0;
        /* 有限容量使用进度控件。 */
        const meter = element('capacity-meter');
        meter.classList.toggle('over', percent > 100);
        meter.setAttribute('aria-valuenow', String(Math.min(100, percent)));
        meter.setAttribute('aria-valuetext', layout.capacity ? `${percent.toFixed(1)}%` : '未设置容量上限');
        element('capacity-fill').style.width = `${Math.min(100, percent)}%`;

        /* 保存布局校验问题的列表。 */
        const issueList = element('issue-list');
        issueList.replaceChildren();
        for (const issue of layout.issues) {
            /* 单个布局校验问题。 */
            const item = document.createElement('li');
            item.textContent = issue;
            issueList.append(item);
        }
        element('issues').hidden = !layout.issues.length;

        /* 将计算结果按 ID 对应到当前资源行。 */
        const plannedRows = new Map(layout.rows.map((row) => [row.resource.id, row]));
        for (const row of element('resource-list').rows) {
            /* 当前资源行及布局。 */
            const planned = plannedRows.get(row.dataset.id);
            /* 计算后的起始地址文字。 */
            const resolved = row.querySelector('.resolved');
            /* 记录长度文字。 */
            const length = row.querySelector('.size');
            row.classList.toggle('omitted', !planned?.enabled);
            row.classList.toggle('invalid', !!planned?.errors.length);
            resolved.textContent = !planned?.enabled ? '已停用' : converter.hex(planned.address);
            length.textContent = sizeText(planned?.enabled ? planned.recordLength : null);
            length.title = planned?.enabled && planned.recordLength != null ? `${planned.recordLength} B` : '';
        }
        syncControls();
    }

    /* 获取 item 的原图预览地址，相同资源重复展示时复用已有地址。 */
    function previewUrl(item) {
        if (!previews.has(item.id)) {
            previews.set(item.id, URL.createObjectURL(item.file));
        }
        return previews.get(item.id);
    }

    /* 释放 itemId 对应的原图预览地址。 */
    function releasePreview(itemId) {
        /* 资源对应的已创建地址。 */
        const address = previews.get(itemId);
        if (address) {
            URL.revokeObjectURL(address);
            previews.delete(itemId);
        }
    }

    /* 按工程顺序重建资源表，每行允许编辑和预览。 */
    function renderItems() {
        /* 图片与预留项的显示模板。 */
        const template = element('resource-row');
        /* 新的表格内容片段。 */
        const fragment = document.createDocumentFragment();
        for (const [index, item] of project.items.entries()) {
            /* 当前资源对应的新表格行。 */
            const row = template.content.firstElementChild.cloneNode(true);
            /* 是否为保留 Flash 地址空间的资源。 */
            const reserved = item.kind === 'reserved';
            /* 原图预览按钮，预留区不显示。 */
            const preview = row.querySelector('.thumb');
            /* 资源名称与地址输入控件。 */
            const name = row.querySelector('[data-field="name"]');
            /* 资源手动起始地址输入控件。 */
            const address = row.querySelector('[data-field="address"]');
            /* 是否参与导出的复选框。 */
            const enabled = row.querySelector('[data-field="enabled"]');
            /* 是否纳入批量删除的复选框。 */
            const selected = row.querySelector('[data-select]');
            row.dataset.id = item.id;
            name.value = item.name;
            name.setAttribute('aria-label', `第 ${index + 1} 项资源名`);
            address.value = item.address;
            address.setAttribute('aria-label', `第 ${index + 1} 项起始地址`);
            enabled.checked = item.enabled !== false;
            enabled.setAttribute('aria-label', `启用第 ${index + 1} 项资源`);
            selected.setAttribute('aria-label', `勾选第 ${index + 1} 项资源`);
            preview.hidden = reserved;
            row.querySelector('.reserve-fields').hidden = !reserved;
            if (reserved) {
                row.querySelector('[data-field="length"]').value = item.length;
                row.querySelector('[data-field="fill"]').value = item.fill;
                row.querySelector('.source').textContent = '预留地址区';
            } else {
                preview.setAttribute('aria-label', `预览 ${item.sourceName}`);
                preview.title = `预览 ${item.sourceName}`;
                preview.firstElementChild.src = previewUrl(item);
                row.querySelector('.source').textContent = `${item.sourceName} · ${item.width} × ${item.height}`;
            }
            row.querySelector('[data-action="up"]').dataset.atBoundary = String(index === 0);
            row.querySelector('[data-action="down"]').dataset.atBoundary = String(index === project.items.length - 1);
            fragment.append(row);
        }
        element('resource-list').replaceChildren(fragment);
        element('empty-state').hidden = project.items.length > 0;
        element('table-wrap').hidden = !project.items.length;
        element('bulk-tools').hidden = !project.items.length;
        /* 总图片数随当前资源更新，预留区单独统计。 */
        const imageCount = project.items.filter((item) => item.kind === 'image').length;
        /* 当前工程中的预留区数量。 */
        const reserveCount = project.items.length - imageCount;
        element('resource-count').textContent = reserveCount ? `${imageCount} 张图片 · ${reserveCount} 个预留区` : `${imageCount} 张图片`;
        syncSelection();
        updateLayout();
    }

    /* 更新工程内容后统一刷新布局并写入自动保存。 */
    function commitItems() {
        renderItems();
        void autosave();
    }

    /* 生成当前工程内无重名的 C 标识符，base 为候选前缀。 */
    function uniqueName(base) {
        /* 当前工程使用的资源名，与固件宏定义一样忽略大小写。 */
        const names = new Set(project.items.map((item) => item.name.trim().toUpperCase()));
        /* 尝试使用的名称。 */
        let candidate = base;
        /* 自动生成的名称后缀。 */
        let suffix = 2;
        while (names.has(candidate.toUpperCase())) {
            candidate = `${base}_${suffix}`;
            suffix += 1;
        }
        return candidate;
    }

    /* 为资源生成稳定的唯一标识符。 */
    function resourceId() {
        return Array.from(crypto.getRandomValues(new Uint32Array(4)), (part) => part.toString(16).padStart(8, '0')).join('');
    }

    /* 在浏览器中读取 file 的原始图像并应用浏览器支持的方向信息。 */
    async function decodeImage(file) {
        /* 临时图片对象地址。 */
        const url = URL.createObjectURL(file);
        /* 浏览器图片解码对象。 */
        const image = new Image();
        try {
            image.src = url;
            await image.decode();
            if (!image.naturalWidth || !image.naturalHeight) {
                throw new Error('图片没有有效尺寸。');
            }
            return image;
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    /* 判断目录文件是否为支持尝试解码的图片，未知 MIME 时检查扩展名。 */
    function isImageFile(file) {
        return file.type.startsWith('image/') || /\.(png|jpe?g|jfif|bmp|gif|webp|ico|avif|svg|tiff?|heif|heic|jxl|apng|jpe)$/i.test(file.name);
    }

    /* 返回 file 的导入相对路径或单独选择时的文件名。 */
    function sourcePath(file) {
        return file.webkitRelativePath || file.name;
    }

    /* 导入 files 中可解码的图片，fromDirectory 时跳过非图片并按路径排序。 */
    async function importImages(files, fromDirectory = false) {
        if (busy || !files.length) {
            return;
        }
        /* 待尝试解码的文件列表，单独选择图片时沿用选择顺序。 */
        const candidates = fromDirectory ? files.filter(isImageFile).sort((first, second) => folderOrder.compare(sourcePath(first), sourcePath(second))) : files;
        if (!candidates.length) {
            status('所选目录没有可导入的图片。', true);
            return;
        }
        /* 本轮导入遇到的文件错误。 */
        const failed = [];
        busy = true;
        syncControls();
        status('正在读取图片…');
        try {
            for (const file of candidates) {
                try {
                    /* 解码后的图片用于读取与取模一致的宽高，单位为像素。 */
                    const decoded = await decodeImage(file);
                    project.items.push({id: resourceId(), kind: 'image', name: uniqueName(converter.imageSymbol(file.name)), sourceName: sourcePath(file), address: '', enabled: true, width: decoded.naturalWidth, height: decoded.naturalHeight, file});
                } catch {
                    failed.push(sourcePath(file));
                }
            }
            commitItems();
            status(failed.length ? `无法读取 ${failed.length} 个文件：${failed.join('、')}` : '', failed.length > 0);
        } finally {
            finishOperation();
        }
    }

    /* 根据当前填充值设置添加一个可编辑的 Flash 预留区。 */
    function addReserve() {
        project.items.push({id: resourceId(), kind: 'reserved', name: uniqueName('Reserve'), address: '', enabled: true, length: '256', fill: project.settings.fillByte});
        commitItems();
    }

    /* 从 input 读取设置并按需要同步芯片预设。 */
    function changeSetting(input) {
        /* 被修改的工程字段键名。 */
        const key = input.id;
        /* 表单更改后的值，同一个值只保存一次。 */
        const value = input.type === 'checkbox' ? input.checked : input.value;
        if (project.settings[key] === value) {
            return;
        }
        project.settings[key] = value;
        if (key === 'preset' && input.value !== 'custom') {
            /* 设定关联的 Flash 容量和对齐配置，单位为字节。 */
            const preset = converter.presets.find((entry) => entry.id === input.value);
            project.settings.capacity = sizeText(preset.capacity);
            project.settings.alignment = converter.hex(preset.alignment, 1);
            element('capacity').value = project.settings.capacity;
            element('alignment').value = project.settings.alignment;
        }
        if (key === 'capacity' || key === 'alignment') {
            project.settings.preset = 'custom';
            element('preset').value = 'custom';
        }
        if (key === 'theme') {
            applyTheme();
        }
        updateLayout();
        void autosave();
    }

    /* 更新 id 对应的预览按钮状态，禁用前将焦点转到原图区域。 */
    function disablePreviewControl(id, disabled) {
        /* 即将更新状态的翻页或缩放按钮。 */
        const button = element(id);
        if (disabled && document.activeElement === button) {
            element('preview-stage').focus({preventScroll: true});
        }
        button.disabled = disabled;
    }

    /* 使用 scale 设置原图缩放比例，fit 为真时按可视区域计算比例。 */
    function setPreviewZoom(scale, fit = false) {
        if (!previewSession || !element('preview').open) {
            return;
        }
        /* 当前显示的图片及其原始像素尺寸。 */
        const item = previewSession.images[previewSession.index];
        /* 可滚动的预览区域。 */
        const stage = element('preview-stage');
        /* 原图预览控件。 */
        const image = element('preview-image');
        /* 四周各保留 12 像素，另计左右或上下边框。 */
        const inset = 26;
        /* 限制局部放大后的图像大小，同时保证可查看 1:1。 */
        const maximum = Math.max(1, Math.min(32, 16384 / Math.max(item.width, item.height)));
        /* 在当前预览区域完整显示原图的比例。 */
        const fitting = Math.min(maximum, Math.max(1, stage.offsetWidth - inset) / item.width, Math.max(1, stage.offsetHeight - inset) / item.height);
        /* 超大图片也允许缩小至适应窗口。 */
        const minimum = Math.min(0.125, fitting);
        /* 手动缩放前视区中心在滚动内容中的相对横坐标。 */
        const centerX = (stage.scrollLeft + stage.clientWidth / 2) / Math.max(1, stage.scrollWidth);
        /* 手动缩放前视区中心在滚动内容中的相对纵坐标。 */
        const centerY = (stage.scrollTop + stage.clientHeight / 2) / Math.max(1, stage.scrollHeight);
        /* 本次实际使用的缩放比例。 */
        const ratio = fit ? fitting : Math.min(maximum, Math.max(minimum, scale));
        previewSession.fit = fit;
        previewSession.scale = ratio;
        image.style.width = `${item.width * ratio}px`;
        image.style.height = `${item.height * ratio}px`;
        element('preview-zoom').value = `${Number((ratio * 100).toFixed(ratio < 0.1 ? 1 : 0))}%`;
        element('preview-fit').setAttribute('aria-pressed', String(fit));
        element('preview-original').setAttribute('aria-pressed', String(!fit && ratio === 1));
        disablePreviewControl('preview-zoom-out', ratio <= minimum);
        disablePreviewControl('preview-zoom-in', ratio >= maximum);
        stage.scrollLeft = fit ? 0 : stage.scrollWidth * centerX - stage.clientWidth / 2;
        stage.scrollTop = fit ? 0 : stage.scrollHeight * centerY - stage.clientHeight / 2;
    }

    /* 显示当前原图、文件信息和在图片资源中的位置。 */
    function renderPreview() {
        /* 窗口中正在显示的图片。 */
        const item = previewSession.images[previewSession.index];
        /* 原图预览控件。 */
        const image = element('preview-image');
        image.alt = item.sourceName;
        image.hidden = false;
        element('preview-error').hidden = true;
        image.src = previewUrl(item);
        element('preview-info').textContent = `${item.sourceName} · ${item.width} × ${item.height} px · ${sizeText(item.file.size)}`;
        element('preview-position').textContent = `${previewSession.index + 1} / ${previewSession.images.length}`;
        disablePreviewControl('preview-previous', previewSession.index === 0);
        disablePreviewControl('preview-next', previewSession.index === previewSession.images.length - 1);
        setPreviewZoom(1, true);
    }

    /* 按当前列表顺序打开 item，预览只包含图片资源。 */
    function showPreview(item) {
        /* 按资源表顺序排列的图片。 */
        const images = project.items.filter((resource) => resource.kind === 'image');
        /* 初次打开时的预览位置。 */
        const index = images.indexOf(item);
        if (index < 0) {
            return;
        }
        previewSession = {images, index, scale: 1, fit: true};
        element('preview').showModal();
        renderPreview();
    }

    /* 按 direction 切换至相邻原图，顺序受图片列表上下边界限制。 */
    function stepPreview(direction) {
        if (!previewSession) {
            return;
        }
        /* 切换后图片在预览列表中的索引。 */
        const next = previewSession.index + direction;
        if (next < 0 || next >= previewSession.images.length) {
            return;
        }
        previewSession.index = next;
        renderPreview();
    }

    /* 按 factor 调整当前原图比例，保留视区中心以便查看局部。 */
    function zoomPreview(factor) {
        if (previewSession) {
            setPreviewZoom(previewSession.scale * factor);
        }
    }

    /* 在原图窗口内处理方向键和缩放快捷键。 */
    function previewKeys(event) {
        if (event.ctrlKey || event.metaKey || event.altKey) {
            return;
        }
        switch (event.key) {
            case 'ArrowLeft':
                stepPreview(-1);
                break;
            case 'ArrowRight':
                stepPreview(1);
                break;
            case '0':
                setPreviewZoom(1, true);
                break;
            case '1':
                setPreviewZoom(1);
                break;
            case '+':
            case '=':
                zoomPreview(1.5);
                break;
            case '-':
                zoomPreview(1 / 1.5);
                break;
            default:
                return;
        }
        event.preventDefault();
    }

    /* 绑定原图窗口控件，视区尺寸变化时重新计算适应比例。 */
    function initializePreview() {
        /* 原图预览窗口。 */
        const dialog = element('preview');
        /* 显示当前图片的元素。 */
        const image = element('preview-image');
        element('preview-previous').addEventListener('click', () => stepPreview(-1));
        element('preview-next').addEventListener('click', () => stepPreview(1));
        element('preview-fit').addEventListener('click', () => setPreviewZoom(1, true));
        element('preview-original').addEventListener('click', () => setPreviewZoom(1));
        element('preview-zoom-out').addEventListener('click', () => zoomPreview(1 / 1.5));
        element('preview-zoom-in').addEventListener('click', () => zoomPreview(1.5));
        dialog.addEventListener('keydown', previewKeys);
        dialog.addEventListener('close', () => {
            if (!dialog.open) {
                previewSession = null;
                image.removeAttribute('src');
            }
        });
        image.addEventListener('error', () => {
            if (dialog.open) {
                image.hidden = true;
                element('preview-error').hidden = false;
            }
        });
        /* 观察原图滚动区域，兼容窗口和工具栏高度变化。 */
        const observer = new ResizeObserver(() => {
            if (previewSession?.fit) {
                setPreviewZoom(1, true);
            }
        });
        observer.observe(element('preview-stage'));
    }

    /* 从工程移除 ids 中的资源，释放缩略图并重新计算图片数与 Flash 布局。 */
    function removeResources(ids) {
        project.items = project.items.filter((item) => !ids.has(item.id));
        for (const id of ids) {
            selectedItems.delete(id);
            releasePreview(id);
        }
        status('');
        commitItems();
    }

    /* 根据勾选状态选中全部资源或取消全部勾选。 */
    function selectAllResources(event) {
        selectedItems.clear();
        if (event.target.checked) {
            for (const item of project.items) {
                selectedItems.add(item.id);
            }
        }
        syncSelection();
    }

    /* 将勾选的资源沿 direction 移动一格，选中项之间保持原有顺序。 */
    function moveSelectedResources(direction) {
        if (busy || !canMoveSelected(direction)) {
            return;
        }
        /* 复用当前资源列表，沿目标方向的反向遍历以避免同一项移动多次。 */
        const items = project.items;
        /* step 为本轮检查的步数，跳过所选方向的边界行。 */
        for (let step = 1; step < items.length; step += 1) {
            /* 上移时从首行之后开始向下扫，下移时从末行之前开始向上扫。 */
            const index = direction < 0 ? step : items.length - 1 - step;
            /* 当前资源所能交换的目标位置。 */
            const neighborIndex = index + direction;
            /* 正在检查是否需要移动的资源。 */
            const item = items[index];
            /* 相邻资源，仅在未勾选时与当前资源交换。 */
            const neighbor = items[neighborIndex];
            if (selectedItems.has(item.id) && !selectedItems.has(neighbor.id)) {
                items[index] = neighbor;
                items[neighborIndex] = item;
            }
        }
        commitItems();
    }

    /* 确认后批量删除选中的资源。 */
    function deleteSelectedResources() {
        if (selectedItems.size && window.confirm(`删除选中的 ${selectedItems.size} 项资源？`)) {
            removeResources(selectedItems);
        }
    }

    /* 确认后清空工程里的图片和预留区。 */
    function clearResources() {
        if (project.items.length && window.confirm(`清空当前工程中的全部 ${project.items.length} 项资源？`)) {
            removeResources(new Set(project.items.map((item) => item.id)));
        }
    }

    /* 处理由资源行触发的预览、重排或移除操作。 */
    function rowAction(event) {
        /* 用户点击的行内操作按钮。 */
        const button = event.target.closest('[data-action]');
        if (busy || !button) {
            return;
        }
        /* 所操作资源当前在工程列表中的位置。 */
        const index = project.items.findIndex((item) => item.id === button.closest('tr').dataset.id);
        /* 当前选中的工程资源。 */
        const item = project.items[index];
        /* 用户请求执行的操作。 */
        const action = button.dataset.action;
        if (action === 'preview') {
            showPreview(item);
            return;
        }
        if (action === 'remove') {
            removeResources(new Set([item.id]));
            return;
        }
        /* 上移或下移后资源的新位置。 */
        const nextIndex = action === 'up' ? index - 1 : index + 1;
        if (nextIndex < 0 || nextIndex >= project.items.length) {
            return;
        }
        project.items.splice(index, 1);
        project.items.splice(nextIndex, 0, item);
        commitItems();
        /* 找回重建后的资源行，让键盘用户能连续调整顺序。 */
        const current = [...element('resource-list').rows].find((row) => row.dataset.id === item.id);
        current?.querySelector(`[data-action="${action}"]:not(:disabled)`)?.focus();
    }

    /* 处理资源表内的名称、地址、长度、填充值或启用状态变更。 */
    function changeItem(event) {
        /* 触发变更的资源编辑控件。 */
        const input = event.target;
        if (busy || !input.dataset.field) {
            return;
        }
        /* 输入控件对应的资源。 */
        const item = project.items.find((entry) => entry.id === input.closest('tr').dataset.id);
        /* 本次输入后的资源值。 */
        const value = input.type === 'checkbox' ? input.checked : input.value;
        if (item[input.dataset.field] === value) {
            return;
        }
        item[input.dataset.field] = value;
        updateLayout();
        void autosave();
    }

    /* 更新行勾选状态，保留资源原有的启用设置。 */
    function changeSelection(event) {
        /* 被点击的行选择框。 */
        const checkbox = event.target;
        if (!checkbox.hasAttribute('data-select')) {
            return;
        }
        /* 当前行的资源 ID。 */
        const id = checkbox.closest('tr').dataset.id;
        if (checkbox.checked) {
            selectedItems.add(id);
        } else {
            selectedItems.delete(id);
        }
        syncSelection();
    }

    /* 通过浏览器下载 blob，name 为建议保存文件名。 */
    function download(blob, name) {
        /* 下载内容的临时地址。 */
        const url = URL.createObjectURL(blob);
        /* 触发浏览器文件保存的链接。 */
        const link = document.createElement('a');
        link.href = url;
        link.download = name;
        document.body.append(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 30000);
    }

    /* 验证随后要打开的工程图片，校正尺寸并保留原始文件。 */
    async function checkProjectImages(candidate) {
        for (const item of candidate.items) {
            if (item.kind === 'image') {
                try {
                    /* 以浏览器实际解码结果为准，单位为像素。 */
                    const image = await decodeImage(item.file);
                    item.width = image.naturalWidth;
                    item.height = image.naturalHeight;
                } catch {
                    throw new Error(`无法读取工程图片：${item.sourceName}`);
                }
            }
        }
    }

    /* 以 candidate 恢复设置和图片，释放原工程的预览地址。 */
    function restore(candidate) {
        element('preview').close();
        selectedItems.clear();
        for (const id of previews.keys()) {
            releasePreview(id);
        }
        project = {settings: {...defaultSettings}, items: candidate.items};
        showSettings(candidate.settings);
        renderItems();
    }

    /* 读取 source 提供的工程文件或系统文件句柄，校验通过后替换当前工程。 */
    async function openProject(source) {
        if (busy || !source) {
            return;
        }
        busy = true;
        syncControls();
        status('正在打开工程…');
        try {
            /* 系统启动传入的句柄需要先读取为与文件选择框相同的 File。 */
            const file = source instanceof File ? source : await source.getFile();
            /* 待验证的工程与内嵌原图。 */
            const candidate = await storage.importFile(file);
            await checkProjectImages(candidate);
            restore(candidate);
            void autosave();
            status(`已打开工程 ${file.name}。`);
        } catch (error) {
            status(error.message, true);
        } finally {
            finishOperation();
        }
    }

    /* 页面空闲时取出下一份系统工程，按接收顺序依次载入。 */
    function openNextLaunchedProject() {
        if (!busy && pendingLaunchFiles.length) {
            void openProject(pendingLaunchFiles.shift());
        }
    }

    /* 接收 launch 中由系统交给已安装应用的工程文件句柄。 */
    function receiveProjectLaunch(launch) {
        pendingLaunchFiles.push(...launch.files);
        openNextLaunchedProject();
    }

    /* 在支持的安全网页环境中接收系统文件并注册离线缓存。 */
    async function initializePwa() {
        if (!window.isSecureContext || !['http:', 'https:'].includes(window.location.protocol)) {
            return;
        }
        if (typeof window.launchQueue?.setConsumer === 'function') {
            window.launchQueue.setConsumer(receiveProjectLaunch);
        }
        if ('serviceWorker' in navigator) {
            try {
                await navigator.serviceWorker.register('./service-worker.js');
            } catch (error) {
                console.warn('离线缓存注册失败。', error);
            }
        }
    }

    /* 更新保存目录显示，memoryOnly 表示仅记住当前会话所选目录。 */
    function showOutputDirectory(memoryOnly = false) {
        /* 保存目录名称显示控件。 */
        const path = element('save-path');
        if (!hasDirectoryPicker) {
            path.textContent = '通过浏览器下载 ZIP';
            return;
        }
        path.textContent = outputDirectory?.name || '尚未选择';
        if (memoryOnly) {
            path.textContent += '（本次会话）';
        }
    }

    /* 由用户点击触发目录选择，在当前浏览器记住选中的目录。 */
    async function pickOutputDirectory() {
        /* 新选择的输出目录句柄。 */
        const directory = await window.showDirectoryPicker({mode: 'readwrite', id: 'itb-export'});
        outputDirectory = directory;
        showOutputDirectory();
        try {
            await storage.saveOutputDirectory(directory);
        } catch {
            showOutputDirectory(true);
        }
        return directory;
    }

    /* 单独更改保存目录，取消时继续使用原目录。 */
    async function changeOutputDirectory() {
        busy = true;
        syncControls();
        try {
            await pickOutputDirectory();
            status('');
        } catch (error) {
            if (error.name !== 'AbortError') {
                status(error.message, true);
            }
        } finally {
            finishOperation();
        }
    }

    /* 保存前获取写入目录，已记住的目录可在用户点击时重新授权。 */
    async function getOutputDirectory() {
        if (!hasDirectoryPicker) {
            return null;
        }
        if (!outputDirectory) {
            return pickOutputDirectory();
        }
        if (typeof outputDirectory.requestPermission === 'function' && await outputDirectory.requestPermission({mode: 'readwrite'}) !== 'granted') {
            throw new Error('未获得保存目录的写入权限。请选择可写入的目录。');
        }
        return outputDirectory;
    }

    /* 查找 directory 下的目标同名文件，entries 包含所有即将写入的文件。 */
    async function existingFiles(directory, entries) {
        /* 已存在的目标文件句柄，供覆盖确认和区分本次新增文件。 */
        const found = new Map();
        for (const entry of entries) {
            try {
                found.set(entry.name, await directory.getFileHandle(entry.name));
            } catch (error) {
                if (error.name === 'TypeMismatchError') {
                    throw new Error(`保存目录中存在同名文件夹「${entry.name}」。`);
                }
                if (error.name !== 'NotFoundError') {
                    throw error;
                }
            }
        }
        return found;
    }

    /* 把 entries 写入 directory，existing 为已确认可覆盖的同名文件。 */
    async function writeExport(directory, entries, existing) {
        /* 待提交写入的文件及其写入流。 */
        const staged = [];
        /* 本次创建的目标文件名。 */
        const created = [];
        /* 已成功提交的目标文件名。 */
        const committed = [];
        try {
            for (const entry of entries) {
                /* 保留已确认同名文件的句柄，其他文件由本次创建。 */
                const handle = existing.get(entry.name) ?? await directory.getFileHandle(entry.name, {create: true});
                if (!existing.has(entry.name)) {
                    created.push(entry.name);
                }
                /* 内容在关闭写入流时才提交。 */
                const stream = await handle.createWritable();
                staged.push({name: entry.name, stream});
                await stream.write(entry.data);
            }
            for (const entry of staged) {
                await entry.stream.close();
                committed.push(entry.name);
            }
        } catch (error) {
            await Promise.allSettled(staged.filter((entry) => !committed.includes(entry.name)).map((entry) => entry.stream.abort()));
            await Promise.allSettled(created.filter((name) => !committed.includes(name)).map((name) => directory.removeEntry(name)));
            /* 已保存的文件无法成组回滚时，明确提供具体文件名。 */
            const partial = committed.length ? ` 已写入：${committed.join('、')}。` : '';
            throw new Error(`写入工程文件失败：${error.message}。${partial}`);
        }
    }

    /* 将工程、BIN、地址映射和 ZIP 一次保存到选定目录。 */
    async function saveProject() {
        if (busy || !layout?.activeCount || layout.issues.length) {
            return;
        }
        /* 本次导出使用的固定布局和取模设置。 */
        const exportLayout = layout;
        busy = true;
        syncControls();
        try {
            /* 目录授权必须由开始导出的用户点击直接触发。 */
            const directory = await getOutputDirectory();
            status('正在生成工程文件…');
            /* 以同一份 Flash 布局生成二进制和映射文件。 */
            const files = await converter.buildFiles(exportLayout, (resource) => converter.decodePixels(resource.file, exportLayout.settings.format));
            /* 工程和 ZIP 均使用与 BIN 相同的文件名前缀。 */
            const stem = files.binName.slice(0, -4);
            /* 保存包含设置和原图的便携工程。 */
            const projectFile = await storage.exportFile(project);
            /* 目录和 ZIP 复用逐字节一致的工程文件。 */
            const projectData = new Uint8Array(await projectFile.arrayBuffer());
            /* ZIP 和独立保存共用这四份文件。 */
            const entries = [{name: files.binName, data: files.bin}, {name: mapHeaderName, data: files.header}, {name: mapCsvName, data: files.csv}, {name: `${stem}.itbproj`, data: projectData}];
            /* ZIP 文件名和内容。 */
            const archiveName = `${stem}.zip`;
            /* 将 BIN、H、CSV 和工程文件统一打包。 */
            const archive = window.ZipExport.create(entries);
            if (!directory) {
                download(archive, archiveName);
                status('已开始下载 ZIP，内含工程、BIN、H 和 CSV。');
                return;
            }
            entries.push({name: archiveName, data: archive});
            /* 写入前检查全部目标名称，避免覆盖用户已有文件。 */
            const existing = await existingFiles(directory, entries);
            if (existing.size && !window.confirm(`目录「${directory.name}」已存在以下文件。是否覆盖？\n${[...existing.keys()].join('\n')}`)) {
                status('已取消保存。');
                return;
            }
            await writeExport(directory, entries, existing);
            status(`已将工程、BIN、H、CSV 和 ZIP 保存到「${directory.name}」。`);
        } catch (error) {
            if (error.name === 'AbortError') {
                status('已取消保存。');
            } else {
                status(error.message, true);
            }
        } finally {
            finishOperation();
        }
    }

    /* 绑定控件并恢复本浏览器上次使用的工程。 */
    async function initialize() {
        populate('format', converter.formats);
        populate('scan', converter.scans);
        populate('preset', converter.presets);
        showSettings(defaultSettings);
        systemTheme.addEventListener('change', applyTheme);
        for (const control of settingInputs) {
            control.addEventListener('change', () => changeSetting(control));
            if (control instanceof HTMLInputElement && control.type !== 'checkbox') {
                control.addEventListener('input', () => changeSetting(control));
            }
        }
        element('choose-save-path').hidden = !hasDirectoryPicker;
        for (const [action, field] of [['import-images', 'image-files'], ['import-directory', 'directory-files']]) {
            /* 单张或目录导入使用各自的文件选择框。 */
            const picker = element(field);
            element(action).addEventListener('click', () => picker.click());
            picker.addEventListener('change', () => {
                /* 复制文件列表，允许之后再次选择同一个文件或目录。 */
                const files = [...picker.files];
                picker.value = '';
                void importImages(files, field === 'directory-files');
            });
        }
        element('open-project').addEventListener('click', () => element('project-file').click());
        element('project-file').addEventListener('change', (event) => {
            /* 已选择的便携工程文件。 */
            const file = event.target.files[0];
            event.target.value = '';
            void openProject(file);
        });
        element('reserve').addEventListener('click', addReserve);
        element('resource-list').addEventListener('click', rowAction);
        element('resource-list').addEventListener('input', changeItem);
        element('resource-list').addEventListener('change', changeItem);
        element('resource-list').addEventListener('change', changeSelection);
        element('select-all').addEventListener('change', selectAllResources);
        element('move-selected-up').addEventListener('click', () => moveSelectedResources(-1));
        element('move-selected-down').addEventListener('click', () => moveSelectedResources(1));
        element('delete-selected').addEventListener('click', deleteSelectedResources);
        element('clear-resources').addEventListener('click', clearResources);
        element('choose-save-path').addEventListener('click', changeOutputDirectory);
        element('save-project').addEventListener('click', saveProject);
        initializePreview();

        /* 图片拖入资源区时阻止浏览器打开源文件。 */
        const target = element('drop-target');
        window.addEventListener('dragover', (event) => {
            if (event.dataTransfer.types.includes('Files')) {
                event.preventDefault();
            }
        });
        window.addEventListener('drop', (event) => {
            if (event.dataTransfer.types.includes('Files')) {
                event.preventDefault();
            }
        });
        target.addEventListener('dragover', (event) => {
            if (!busy && event.dataTransfer.types.includes('Files')) {
                event.dataTransfer.dropEffect = 'copy';
                target.classList.add('dragging');
            }
        });
        target.addEventListener('dragleave', (event) => {
            if (!target.contains(event.relatedTarget)) {
                target.classList.remove('dragging');
            }
        });
        target.addEventListener('drop', (event) => {
            target.classList.remove('dragging');
            void importImages([...event.dataTransfer.files]);
        });

        /* 本地工程恢复状态。 */
        const label = element('storage-status');
        /* 并行恢复保存目录，失败时仍允许重新选择。 */
        const rememberedDirectory = hasDirectoryPicker ? storage.loadOutputDirectory().catch(() => null) : Promise.resolve(null);
        try {
            /* 此网页路径上次保存的工程。 */
            const saved = await storage.load();
            if (saved) {
                restore(saved);
                label.textContent = '已恢复上次的本地工程';
            } else {
                label.textContent = '更改会自动保存到此浏览器';
            }
        } catch {
            label.textContent = '无法恢复本地工程，可以打开已保存的工程文件。';
            label.classList.add('error');
        } finally {
            outputDirectory = await rememberedDirectory;
            showOutputDirectory();
            busy = false;
            renderItems();
            openNextLaunchedProject();
        }
    }

    void initializePwa();
    void initialize();
})();
