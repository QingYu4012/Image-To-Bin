/* 图片取模、Flash 地址规划和映射文件导出。 */
(() => {
    'use strict';

    /* Flash 地址及映射字段支持的最大值。 */
    const maxUint32 = 0xFFFFFFFF;
    /* 旧版图片记录中宽、高及数据长度占用的字节数。 */
    const imageHeaderLength = 8;
    /* 旧版取模颜色格式和每像素位数。 */
    const formats = [
        { id: 'rgb565_word', label: 'RGB565 · uint16_t', bits: 16, word: true },
        { id: 'rgb565_bytes_be', label: 'RGB565 · 高字节在前', bits: 16, byteOrder: 'big' },
        { id: 'rgb565_bytes_le', label: 'RGB565 · 低字节在前', bits: 16, byteOrder: 'little' },
        { id: 'bgr565_word', label: 'BGR565 · uint16_t', bits: 16, word: true, bgr: true },
        { id: 'bgr565_bytes_be', label: 'BGR565 · 高字节在前', bits: 16, byteOrder: 'big', bgr: true },
        { id: 'bgr565_bytes_le', label: 'BGR565 · 低字节在前', bits: 16, byteOrder: 'little', bgr: true },
        { id: 'rgb888', label: 'RGB888', bits: 24, channels: 'rgb' },
        { id: 'bgr888', label: 'BGR888', bits: 24, channels: 'bgr' },
        { id: 'rgba8888', label: 'RGBA8888', bits: 32, channels: 'rgba' },
        { id: 'argb8888', label: 'ARGB8888', bits: 32, channels: 'argb' },
        { id: 'bgra8888', label: 'BGRA8888', bits: 32, channels: 'bgra' },
        { id: 'gray8', label: 'Gray8 · 八位灰度', bits: 8 },
        { id: 'mono1', label: 'Mono1 · 单色位打包', bits: 1 }
    ];
    /* 逐行、逐列和两条坐标轴方向的组合。 */
    const scans = [
        { id: 'row_ltr_ttb', label: '行扫描 · 左至右，上至下' },
        { id: 'row_rtl_ttb', label: '行扫描 · 右至左，上至下', reverseX: true },
        { id: 'row_ltr_btt', label: '行扫描 · 左至右，下至上', reverseY: true },
        { id: 'row_rtl_btt', label: '行扫描 · 右至左，下至上', reverseX: true, reverseY: true },
        { id: 'col_ttb_ltr', label: '列扫描 · 上至下，左至右', column: true },
        { id: 'col_btt_ltr', label: '列扫描 · 下至上，左至右', column: true, reverseY: true },
        { id: 'col_ttb_rtl', label: '列扫描 · 上至下，右至左', column: true, reverseX: true },
        { id: 'col_btt_rtl', label: '列扫描 · 下至上，右至左', column: true, reverseX: true, reverseY: true }
    ];
    /* 存储器容量和页对齐预设，单位为字节。 */
    const presets = [
        { id: 'custom', label: '自定义', capacity: 0, alignment: 1 },
        { id: '24c02', label: '24C02 · 256 B', capacity: 256, alignment: 8 },
        { id: '24c04', label: '24C04 · 512 B', capacity: 512, alignment: 8 },
        { id: '24c08', label: '24C08 · 1 KiB', capacity: 1024, alignment: 16 },
        { id: '24c16', label: '24C16 · 2 KiB', capacity: 2048, alignment: 16 },
        { id: '24c32', label: '24C32 · 4 KiB', capacity: 4096, alignment: 32 },
        { id: '24c64', label: '24C64 · 8 KiB', capacity: 8192, alignment: 32 },
        { id: '24c128', label: '24C128 · 16 KiB', capacity: 16 * 1024, alignment: 64 },
        { id: '24c256', label: '24C256 · 32 KiB', capacity: 32 * 1024, alignment: 64 },
        { id: '24c512', label: '24C512 · 64 KiB', capacity: 64 * 1024, alignment: 128 },
        { id: '25q40', label: '25Q40 · 512 KiB', capacity: 512 * 1024, alignment: 256 },
        { id: '25q80', label: '25Q80 · 1 MiB', capacity: 1024 * 1024, alignment: 256 },
        { id: '25q16', label: '25Q16 · 2 MiB', capacity: 2 * 1024 * 1024, alignment: 256 },
        { id: '25q32', label: '25Q32 · 4 MiB', capacity: 4 * 1024 * 1024, alignment: 256 },
        { id: '25q64', label: '25Q64 · 8 MiB', capacity: 8 * 1024 * 1024, alignment: 256 },
        { id: '25q128', label: '25Q128 · 16 MiB', capacity: 16 * 1024 * 1024, alignment: 256 }
    ];
    /* 默认参数与现有 SYSTEM_UI 的 Flash 资源格式一致。 */
    const defaults = Object.freeze({
        format: 'rgb565_word',
        scan: 'row_ltr_ttb',
        monoThreshold: 128,
        monoBitOrder: 'msb',
        monoOneValue: 'light',
        endian: 'big',
        includeHeader: true,
        preset: '25q40',
        capacity: '512 KB',
        startAddress: '0x000000',
        alignment: '0x100',
        fillByte: '0xFF',
        mapPrefix: 'SYSTEM_UI',
        binName: 'system_ui_images'
    });
    /* 保留透明度的格式共用一个延迟建立的 WebGL 上下文。 */
    let webglContext = undefined;

    /* 解析数值，label 为错误提示字段名，max 为允许的最大值。 */
    function parseNumber(value, label = '数值', max = maxUint32) {
        /* 去除首尾空白与用于分组的下划线。 */
        const text = String(value ?? '').trim().replaceAll('_', '');
        /* 数值及可选的容量单位。 */
        const match = /^(0[xX][\da-fA-F]+|\d+)(?:\s*(KiB|KB|K|MiB|MB|M|B))?$/i.exec(text);
        if (!match) {
            throw new Error(`${label}请输入十进制、0x 十六进制或带 KB、MB 的整数`);
        }
        /* 单位换算倍率，KB 和 MB 按旧工具以 1024 进位。 */
        const units = { b: 1, k: 1024, kb: 1024, kib: 1024, m: 1048576, mb: 1048576, mib: 1048576 };
        /* 换算后的数值。 */
        const result = Number(match[1]) * units[(match[2] || 'B').toLowerCase()];
        if (!Number.isSafeInteger(result) || result > max) {
            throw new Error(`${label}须在 0 至 ${hex(max)} 之间`);
        }
        return result;
    }

    /* 将 value 显示为十六进制，width 是不含 0x 的最小位数。 */
    function hex(value, width = 8) {
        return value == null ? '' : `0x${value.toString(16).toUpperCase().padStart(width, '0')}`;
    }

    /* 判断 value 是否为 C 标识符。 */
    function validName(value) {
        return /^[A-Za-z_][A-Za-z_0-9]*$/.test(value);
    }

    /* 将文件名 filename 转换为沿用旧工具 Image_ 前缀的资源名称。 */
    function imageSymbol(filename) {
        /* 文件名最后一段，不含扩展名。 */
        const stem = String(filename).split(/[\\/]/).pop().replace(/\.[^.]+$/, '').trim();
        /* 按旧版图片工具将非 ASCII 字符转为 Unicode 编码标识。 */
        const encoded = Array.from(stem, (character) => {
            if (/[A-Za-z_0-9]/.test(character)) {
                return character;
            }
            if (' -.+()[]{}'.includes(character)) {
                return '_';
            }
            return `_u${character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
        }).join('').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
        /* 补齐数字开头的标识符片段，保持旧版转换规则。 */
        const suffix = /^\d/.test(encoded) ? `_${encoded}` : encoded;
        return `Image_${suffix || 'image'}`.replace(/_+/g, '_');
    }

    /* 检查 options 的颜色、扫描和单色取模设置。 */
    function readPixelOptions(options) {
        /* 目标像素存储格式。 */
        const format = formats.find((item) => item.id === options.format);
        /* 目标像素扫描方向。 */
        const scan = scans.find((item) => item.id === options.scan);
        if (!format || !scan) {
            throw new Error('请选择有效的颜色格式和扫描方向');
        }
        if (options.endian !== 'little' && options.endian !== 'big') {
            throw new Error('请选择有效的字节序');
        }
        if (format.id === 'mono1' && !['msb', 'lsb'].includes(options.monoBitOrder)) {
            throw new Error('请选择有效的单色位序');
        }
        if (format.id === 'mono1' && !['light', 'dark'].includes(options.monoOneValue)) {
            throw new Error('请选择有效的单色极性');
        }
        /* 灰度达到此阈值时视为亮色，单位为灰度级。 */
        const threshold = format.id === 'mono1' ? parseNumber(options.monoThreshold, '单色阈值', 255) : 128;
        return { format, scan, threshold };
    }

    /* 计算 width × height 像素按 format 取模后的字节数。 */
    function imageDataLength(width, height, format) {
        if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width > 0xFFFF || height > 0xFFFF) {
            throw new Error('图片尺寸无效，宽和高必须在 1 至 65535 像素之间');
        }
        /* 单色位打包后最后一个字节可能不足八位。 */
        const bytes = Math.ceil(width * height * format.bits / 8);
        if (bytes > maxUint32) {
            throw new Error('图片数据超过 32 位长度范围');
        }
        return bytes;
    }

    /* 使用 2D Canvas 读取已解码图片 image 的 width × height 像素。 */
    function readCanvasPixels(image, width, height) {
        /* 每次导出只保留当前图片的绘图缓冲区。 */
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        /* 用于提取 RGBA 数据的画布上下文。 */
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) {
            throw new Error('浏览器无法建立图片取模画布');
        }
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, width, height);
    }

    /* 从 bitmap 提取未预乘的 RGBA 通道，WebGL 不可用时返回空值。 */
    function readStraightAlpha(bitmap) {
        if (webglContext === undefined) {
            webglContext = document.createElement('canvas').getContext('webgl', { antialias: false, depth: false, premultipliedAlpha: false });
        }
        /* 读取原始 RGBA 的 WebGL 上下文。 */
        const gl = webglContext;
        if (!gl || gl.isContextLost()) {
            return null;
        }
        /* 浏览器设备支持的最大纹理边长，单位为像素。 */
        const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        if (bitmap.width > maxSize || bitmap.height > maxSize) {
            return null;
        }
        /* 上传原始 RGBA 的纹理。 */
        const texture = gl.createTexture();
        /* 绑定纹理供 readPixels 直接读取的帧缓冲区。 */
        const framebuffer = gl.createFramebuffer();
        try {
            if (!texture || !framebuffer) {
                return null;
            }
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
            gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
            gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
            if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
                return null;
            }
            /* 按浏览器解码后的图像尺寸分配 RGBA 通道字节。 */
            const data = new Uint8Array(bitmap.width * bitmap.height * 4);
            gl.readPixels(0, 0, bitmap.width, bitmap.height, gl.RGBA, gl.UNSIGNED_BYTE, data);
            if (gl.getError() !== gl.NO_ERROR) {
                return null;
            }
            return { data, width: bitmap.width, height: bitmap.height };
        } finally {
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.bindTexture(gl.TEXTURE_2D, null);
            gl.deleteFramebuffer(framebuffer);
            gl.deleteTexture(texture);
        }
    }

    /* 将图片文件 blob 解码为 RGBA，format 为目标颜色格式。 */
    async function decodePixels(blob, format = defaults.format) {
        /* RGBA、ARGB 和 BGRA 格式需要保留未预乘的颜色及透明度。 */
        const straightAlpha = ['rgba8888', 'argb8888', 'bgra8888'].includes(format);
        /* 浏览器按源图方向解码的第一帧，无法使用 ImageBitmap 时回退到图片元素。 */
        let bitmap = null;
        if (typeof createImageBitmap === 'function') {
            try {
                bitmap = await createImageBitmap(blob, straightAlpha ? { premultiplyAlpha: 'none', colorSpaceConversion: 'none' } : {});
            } catch {
                /* 部分浏览器仅允许通过 HTML 图片元素读取指定格式。 */
            }
        }
        if (bitmap) {
            try {
                if (straightAlpha) {
                    try {
                        /* 硬件能力允许时读取包含透明像素原色的通道字节。 */
                        const pixels = readStraightAlpha(bitmap);
                        if (pixels) {
                            return pixels;
                        }
                    } catch {
                        /* WebGL 不可用时沿用 2D Canvas 的 RGBA 解码。 */
                    }
                }
                return readCanvasPixels(bitmap, bitmap.width, bitmap.height);
            } finally {
                bitmap.close();
            }
        }
        /* 图片元素的本地对象地址，解码完成后释放。 */
        const url = URL.createObjectURL(blob);
        try {
            /* 兼容 ImageBitmap 无法解码的浏览器支持格式。 */
            const image = new Image();
            image.src = url;
            await image.decode();
            return readCanvasPixels(image, image.naturalWidth, image.naturalHeight);
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    /* 将 RGBA 像素 imageData 按 options 取模为完整的 Flash 图片记录。 */
    function encodeImage(imageData, options = defaults) {
        /* 合并调用方指定的取模和记录选项。 */
        const settings = { ...defaults, ...options };
        /* 已验证的颜色格式、扫描方向和单色阈值。 */
        const pixelOptions = readPixelOptions(settings);
        /* 输入图片宽度，单位为像素。 */
        const width = imageData.width;
        /* 输入图片高度，单位为像素。 */
        const height = imageData.height;
        /* 逐行存放的 RGBA 通道字节。 */
        const pixels = imageData.data;
        /* 取模后的业务数据长度，单位为字节。 */
        const dataLength = imageDataLength(width, height, pixelOptions.format);
        /* 业务数据相对记录开始的偏移，单位为字节。 */
        const offset = settings.includeHeader ? imageHeaderLength : 0;
        if (pixels?.length !== width * height * 4) {
            throw new Error('RGBA 像素数据与图片尺寸不一致');
        }
        if (dataLength + offset > maxUint32) {
            throw new Error('图片记录超过 32 位长度范围');
        }
        /* 完整记录字节数组，单色最后一个字节的空位保持为 0。 */
        const record = new Uint8Array(dataLength + offset);
        /* 取模颜色格式。 */
        const format = pixelOptions.format;
        /* 取模扫描方向。 */
        const scan = pixelOptions.scan;
        if (offset) {
            /* uint16_t 图片头按字序逐字写出，字节流图片头固定小端。 */
            const littleHeader = !format.word || settings.endian === 'little';
            /* 用显式端序写入四个 16 位字段。 */
            const header = new DataView(record.buffer);
            header.setUint16(0, width, littleHeader);
            header.setUint16(2, height, littleHeader);
            header.setUint16(4, dataLength & 0xFFFF, littleHeader);
            header.setUint16(6, dataLength >>> 16, littleHeader);
        }

        /* 输出光标，单位为字节。 */
        let output = offset;
        /* 一条扫描线包含的像素数。 */
        const span = scan.column ? height : width;
        /* 输入像素总数。 */
        const count = width * height;
        /* 取模格式是否保留透明度。 */
        const preserveAlpha = format.bits === 32;
        /* 565 像素是否先写低字节。 */
        const littlePixel = (format.word ? settings.endian : format.byteOrder) === 'little';
        /* 目标通道排列，从标准 RGBA 映射到 24 位或 32 位格式。 */
        const channels = Array.from(format.channels || '', (channel) => 'rgba'.indexOf(channel));
        /* 重用当前像素的通道缓冲区，避免逐像素分配数组。 */
        const rgba = new Uint8Array(4);

        /* 按选定的扫描顺序遍历像素。 */
        for (let index = 0; index < count; index += 1) {
            /* 当前扫描线的序号。 */
            const line = Math.floor(index / span);
            /* 像素在线内的序号。 */
            const position = index % span;
            /* 左到右的像素横坐标。 */
            const x = scan.column ? line : position;
            /* 上到下的像素纵坐标。 */
            const y = scan.column ? position : line;
            /* 应用翻转后，该像素在行优先输入中的字节偏移。 */
            const source = ((scan.reverseY ? height - 1 - y : y) * width + (scan.reverseX ? width - 1 - x : x)) * 4;
            /* 非透明格式将源像素与黑色背景合成。 */
            const alpha = preserveAlpha ? 1 : pixels[source + 3] / 255;
            /* 合成后的红通道字节。 */
            const red = Math.round(pixels[source] * alpha);
            /* 合成后的绿通道字节。 */
            const green = Math.round(pixels[source + 1] * alpha);
            /* 合成后的蓝通道字节。 */
            const blue = Math.round(pixels[source + 2] * alpha);

            if (format.bits === 16) {
                /* RGB565 或 BGR565 的 16 位像素值。 */
                const word = format.bgr ? ((blue & 0xF8) << 8) | ((green & 0xFC) << 3) | (red >> 3) : ((red & 0xF8) << 8) | ((green & 0xFC) << 3) | (blue >> 3);
                record[output] = littlePixel ? word & 0xFF : word >>> 8;
                record[output + 1] = littlePixel ? word >>> 8 : word & 0xFF;
                output += 2;
            } else if (channels.length) {
                /* 24 位格式使用合成值，32 位格式保留原有通道值。 */
                rgba[0] = red;
                rgba[1] = green;
                rgba[2] = blue;
                rgba[3] = pixels[source + 3];
                /* 按目标通道顺序输出当前像素。 */
                for (const channel of channels) {
                    record[output] = rgba[channel];
                    output += 1;
                }
            } else {
                /* 亮度灰度值使用与旧取模工具一致的整数权重。 */
                const luminance = Math.floor((red * 299 + green * 587 + blue * 114 + 500) / 1000);
                if (format.bits === 8) {
                    record[output] = luminance;
                    output += 1;
                } else if ((luminance >= pixelOptions.threshold) === (settings.monoOneValue === 'light')) {
                    /* 同一图片的单色像素连续打包，行尾与列尾不插入填充。 */
                    const bit = settings.monoBitOrder === 'msb' ? 7 - index % 8 : index % 8;
                    record[offset + Math.floor(index / 8)] |= 1 << bit;
                }
            }
        }
        return record;
    }

    /* 根据 resources 和 options 计算地址布局、统计项和阻止导出的错误。 */
    function plan(resources, options = defaults) {
        /* 合并默认设置，保留用户填写的数值文本。 */
        const settings = { ...defaults, ...options };
        /* 所有会阻止导出的问题，按全局设置及表格顺序返回。 */
        const issues = [];
        /* 收集出错提示时返回空值，允许界面同时展示其他可计算的字段。 */
        function check(callback, onError = (message) => issues.push(message)) {
            try {
                return callback();
            } catch (error) {
                onError(error.message);
                return null;
            }
        }

        /* 可用 Flash 容量，单位为字节，0 表示不限定芯片容量。 */
        const capacity = check(() => parseNumber(settings.capacity, 'Flash 容量'));
        /* 自动排址的最低地址，单位为字节。 */
        const startAddress = check(() => parseNumber(settings.startAddress, '起始地址'));
        /* 自动排址的对齐值，单位为字节。 */
        const alignment = check(() => {
            /* 用户输入的对齐值，单位为字节。 */
            const value = parseNumber(settings.alignment, '地址对齐');
            if (!value) {
                throw new Error('地址对齐至少为 1 字节');
            }
            return value;
        });
        /* 任何未被资源覆盖的地址所写入的字节。 */
        const fillByte = check(() => parseNumber(settings.fillByte, '空隙填充值', 0xFF));
        /* 输出 C 头文件使用的宏名前缀。 */
        const mapPrefix = String(settings.mapPrefix ?? '').trim().toUpperCase();
        /* BIN 文件名，不含扩展名。 */
        const binStem = String(settings.binName ?? '').trim().replace(/\.bin$/i, '');
        /* 计算数据长度所用的颜色信息及扫描选项。 */
        const pixelOptions = check(() => readPixelOptions(settings));
        if (!validName(mapPrefix)) {
            issues.push('C 宏前缀须为有效的 C 标识符');
        }
        if (!/^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(binStem) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(binStem)) {
            issues.push('BIN 文件名须使用字母、数字、下划线或连字符，并使用有效的文件名');
        }

        /* 与页面资源顺序对应的布局行。 */
        const rows = resources.map((resource) => {
            /* 保留块没有尺寸，直接按指定长度和填充值落盘。 */
            const reserved = resource.kind === 'reserved';
            /* 当前资源是否参与导出。 */
            const enabled = resource.enabled !== false;
            /* 映射中的 C 符号名。 */
            const name = String(resource.name ?? '').trim();
            /* 当前行独有的错误信息。 */
            const errors = [];
            /* 资源记录是否含有图片数据头。 */
            const hasHeader = !reserved && settings.includeHeader;
            /* 地址为空时由自动布局计算。 */
            const fixed = resource.address != null && String(resource.address).trim() !== '';
            /* 资源记录首字节的手动地址。 */
            const address = fixed ? check(() => parseNumber(resource.address, '记录地址'), (message) => errors.push(message)) : null;
            /* 图片业务数据或保留区长度，单位为字节。 */
            const dataLength = reserved
                ? check(() => parseNumber(resource.length, '保留长度'), (message) => errors.push(message))
                : pixelOptions && check(() => imageDataLength(resource.width, resource.height, pixelOptions.format), (message) => errors.push(message));
            /* 图片头长度，单位为字节。 */
            const headerLength = hasHeader ? imageHeaderLength : 0;
            /* 包含可选图片头的实际写入字节数。 */
            const recordLength = dataLength == null ? null : dataLength + headerLength;
            /* 保留块的实际填充值，留空时继承项目填充值。 */
            const reserveFill = reserved && String(resource.fill ?? '').trim() !== ''
                ? check(() => parseNumber(resource.fill, '保留块填充值', 0xFF), (message) => errors.push(message))
                : fillByte;
            /* 旧版映射声明的 C 数组元素位数。 */
            const elementBits = !reserved && pixelOptions?.format.word ? 16 : 8;

            if (enabled && !validName(name)) {
                errors.push('资源名称须为有效的 C 标识符');
            }
            if (enabled && name.toUpperCase() === 'NUM') {
                errors.push('资源名称 NUM 与映射数量枚举冲突');
            }
            if (enabled && reserved && dataLength === 0) {
                errors.push('保留长度至少为 1 字节');
            }
            if (enabled && recordLength > maxUint32) {
                errors.push('记录长度超过 32 位范围');
            }
            return {
                resource,
                kind: reserved ? 'reserved' : 'image',
                name,
                symbol: reserved ? 'Reserve_Block' : name,
                width: reserved ? null : resource.width,
                height: reserved ? null : resource.height,
                enabled,
                fixed,
                address,
                dataAddress: null,
                endAddress: null,
                dataLength,
                recordLength,
                headerLength,
                elementBits,
                cType: reserved ? 'reserve' : `uint${elementBits}_t`,
                fillByte: reserveFill,
                errors
            };
        });
        /* 参与地址规划的资源行。 */
        const active = rows.filter((row) => row.enabled);
        /* 预先保留所有有效的手动地址范围，避免自动地址撞上后续固定资源。 */
        const fixedRanges = active
            .filter((row) => row.fixed && row.address != null && row.recordLength > 0)
            .map((row) => ({ start: row.address, end: row.address + row.recordLength }))
            .sort((left, right) => left.start - right.start);
        /* 当前自动排址光标，单位为字节。 */
        let cursor = startAddress;
        /* 已越过的固定范围数量。 */
        let fixedIndex = 0;
        /* 按列表顺序为每条启用资源计算记录地址。 */
        for (const row of active) {
            if (!row.fixed && cursor != null && alignment != null && row.recordLength > 0) {
                /* 资源开始地址须向上对齐。 */
                let address = Math.ceil(cursor / alignment) * alignment;
                while (fixedIndex < fixedRanges.length && fixedRanges[fixedIndex].start < address + row.recordLength) {
                    /* 和当前候选范围可能相交的固定范围。 */
                    const range = fixedRanges[fixedIndex];
                    if (address < range.end) {
                        address = Math.ceil(range.end / alignment) * alignment;
                    }
                    fixedIndex += 1;
                }
                row.address = address;
                cursor = address + row.recordLength;
            }

            if (row.address != null && row.recordLength > 0) {
                row.dataAddress = row.address + row.headerLength;
                row.endAddress = row.address + row.recordLength;
                if (row.endAddress > maxUint32) {
                    row.errors.push('地址范围超过 32 位');
                } else if (capacity && row.endAddress > capacity) {
                    row.errors.push(`结束地址 ${hex(row.endAddress)} 超出 Flash 容量 ${hex(capacity)}`);
                }
            }
        }

        /* 每个映射标识对应的首个资源，用于避免编译时重复定义。 */
        const owners = new Map();
        /* 检查每条资源生成的 C 枚举项及宏名称。 */
        for (const row of active) {
            if (!validName(row.name)) {
                continue;
            }
            /* C 宏和枚举的资源名统一为大写。 */
            const name = row.name.toUpperCase();
            /* 枚举及六个旧版宏可能因资源前后缀而同名。 */
            const names = [`ID_${name}`, `${name}_ADDR`, `${name}_DATA_ADDR`, `${name}_RECORD_LEN`, `${name}_DATA_LEN`, `${name}_WIDTH`, `${name}_HEIGHT`];
            /* 查找当前资源生成的标识是否已经被占用。 */
            for (const identifier of names) {
                /* 已占用此映射标识的资源行。 */
                const owner = owners.get(identifier);
                if (owner) {
                    row.errors.push(`与 ${owner.name} 的映射名称冲突`);
                    owner.errors.push(`与 ${row.name} 的映射名称冲突`);
                } else {
                    owners.set(identifier, row);
                }
            }
        }
        /* 按首地址排序，用于检查范围重叠及计算 BIN 长度。 */
        const addressed = active.filter((row) => row.endAddress != null).sort((left, right) => left.address - right.address);
        /* 目前为止结束地址最远的资源行。 */
        let previous = null;
        /* 检查当前记录是否与更低地址的记录重叠。 */
        for (const row of addressed) {
            if (previous && row.address < previous.endAddress) {
                row.errors.push(`与 ${previous.name} 的地址范围重叠`);
                previous.errors.push(`与 ${row.name} 的地址范围重叠`);
            }
            if (!previous || row.endAddress > previous.endAddress) {
                previous = row;
            }
        }

        /* 汇总每行需要修正的问题。 */
        for (const row of active) {
            row.errors = [...new Set(row.errors)];
            issues.push(...row.errors.map((message) => `${row.name || '未命名资源'}：${message}`));
        }
        /* 图片业务数据总量，单位为字节。 */
        const payloadBytes = active.reduce((total, row) => total + (row.kind === 'image' ? row.dataLength || 0 : 0), 0);
        /* 图片记录总量，包含图片头，单位为字节。 */
        const recordBytes = active.reduce((total, row) => total + (row.kind === 'image' ? row.recordLength || 0 : 0), 0);
        /* 保留块占用量，单位为字节。 */
        const reservedBytes = active.reduce((total, row) => total + (row.kind === 'reserved' ? row.recordLength || 0 : 0), 0);
        /* 总资源占用量，单位为字节。 */
        const usedBytes = recordBytes + reservedBytes;
        /* BIN 自地址 0 起到最后一条记录结束的长度，单位为字节。 */
        const size = previous?.endAddress ?? 0;

        return {
            rows,
            issues,
            settings,
            size,
            capacity,
            fillByte,
            payloadBytes,
            recordBytes,
            reservedBytes,
            usedBytes,
            gapBytes: Math.max(0, size - usedBytes),
            remainingBytes: capacity ? Math.max(0, capacity - usedBytes) : null,
            activeCount: active.length,
            mapPrefix,
            binName: `${binStem}.bin`
        };
    }

    /* 根据有效布局 layout 及导出行 rows 生成固件兼容的 C 映射。 */
    function buildHeader(layout, rows) {
        /* 给现有固件宏、枚举及类型使用的统一前缀。 */
        const prefix = layout.mapPrefix;
        /* 映射表实例及编译期实现开关。 */
        const symbol = `g_${prefix.toLowerCase()}_map`;
        /* 头文件各行，最后保留一个换行。 */
        const lines = [
            '/* 由 Image to BIN 自动生成。地址从 Flash 起点 0 计算。 */',
            `#ifndef ${prefix}_MAP_H`,
            `#define ${prefix}_MAP_H`,
            '',
            '#include <stdint.h>',
            '',
            '/* 导出的资源条目数量。 */',
            `#define ${prefix}_COUNT             ${rows.length}u`,
            '/* BIN 文件大小，单位为字节。 */',
            `#define ${prefix}_BIN_SIZE          ${hex(layout.size)}u`,
            '/* 未占用区域填充值。 */',
            `#define ${prefix}_FILL_BYTE         ${hex(layout.fillByte, 2)}u`,
            '/* Flash 容量，单位为字节，0 表示未指定。 */',
            `#define ${prefix}_FLASH_CAPACITY    ${hex(layout.capacity)}u`,
            '',
            '/* 资源索引按导出时的列表顺序分配。 */',
            'typedef enum',
            '{'
        ];
        rows.forEach((row, index) => {
            lines.push('    /* 当前资源的映射表索引。 */');
            lines.push(`    ${prefix}_ID_${row.name.toUpperCase()} = ${index},`);
        });
        lines.push(
            '    /* 资源索引总数。 */',
            `    ${prefix}_ID_NUM = ${rows.length}`,
            `} ${prefix}_Id_t;`,
            '',
            '/* 外部 Flash 中单条资源的地址、长度及尺寸。 */',
            'typedef struct',
            '{',
            '    /* 资源记录首地址，单位为字节。 */',
            '    uint32_t Address;',
            '    /* 业务数据首地址，单位为字节。 */',
            '    uint32_t Data_Address;',
            '    /* 写入记录总长度，单位为字节。 */',
            '    uint32_t Record_Length;',
            '    /* 业务数据长度，单位为字节。 */',
            '    uint32_t Data_Length;',
            '    /* 图片宽度，单位为像素。 */',
            '    uint16_t Width;',
            '    /* 图片高度，单位为像素。 */',
            '    uint16_t Height;',
            `} ${prefix}_Info_t;`,
            ''
        );
        /* 为每条资源生成供固件直接引用的地址及尺寸宏。 */
        for (const row of rows) {
            /* 单条资源宏的完整前缀。 */
            const name = `${prefix}_${row.name.toUpperCase()}`;
            lines.push(
                '/* 资源记录首地址，单位为字节。 */',
                `#define ${name}_ADDR          ${hex(row.address)}u`,
                '/* 业务数据首地址，单位为字节。 */',
                `#define ${name}_DATA_ADDR     ${hex(row.dataAddress)}u`,
                '/* 记录总长度，单位为字节。 */',
                `#define ${name}_RECORD_LEN    ${row.recordLength}u`,
                '/* 业务数据长度，单位为字节。 */',
                `#define ${name}_DATA_LEN      ${row.dataLength}u`,
                '/* 图片宽度，单位为像素，保留块为 0。 */',
                `#define ${name}_WIDTH         ${row.width || 0}u`,
                '/* 图片高度，单位为像素，保留块为 0。 */',
                `#define ${name}_HEIGHT        ${row.height || 0}u`,
                ''
            );
        }
        lines.push(
            '/* 资源映射表声明。 */',
            `extern const ${prefix}_Info_t ${symbol}[${prefix}_COUNT];`,
            '',
            `#ifdef ${prefix}_MAP_IMPLEMENTATION`,
            '/* 在定义实现开关的一个编译单元中生成资源映射表。 */',
            `const ${prefix}_Info_t ${symbol}[${prefix}_COUNT] =`,
            '{',
            ...rows.map((row) => `    { ${hex(row.address)}u, ${hex(row.dataAddress)}u, ${row.recordLength}u, ${row.dataLength}u, ${row.width || 0}u, ${row.height || 0}u },`),
            '};',
            `#endif /* ${prefix}_MAP_IMPLEMENTATION */`,
            '',
            `#endif /* ${prefix}_MAP_H */`,
            ''
        );
        return lines.join('\n');
    }

    /* 将 CSV 字段 value 转义为表格可识别的文本。 */
    function csvCell(value) {
        /* 空字段留空，其余引用按 CSV 标准对引号双写。 */
        const text = String(value ?? '');
        return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
    }

    /* 按有效布局 layout 和导出行 rows 生成 UTF-8 CSV 映射。 */
    function buildCsv(layout, rows) {
        /* 保留旧工具地址映射列和顺序，附加实际颜色格式及扫描方向。 */
        const columns = 'index,kind,name,symbol,source,address,data_address,width,height,data_len,record_len,end_address,type,element_bits,endian,export_mode,format,scan';
        /* 目标像素存储格式。 */
        const format = formats.find((item) => item.id === layout.settings.format);
        /* 每条映射记录的 CSV 行。 */
        const lines = rows.map((row, index) => {
            /* 图片原始文件名，保留块没有源文件。 */
            const source = row.kind === 'image' ? row.resource.sourceName || row.resource.file?.name || '' : '';
            /* 数组字节序，字节流的 565 格式使用显式设置。 */
            const byteOrder = format.word ? layout.settings.endian : format.byteOrder;
            /* 字节序的旧版显示文本。 */
            const endian = { little: '小端(低字节在前)', big: '大端(高字节在前)' };
            /* 工作表将此类前缀识别为表达式，按文字输出文件名。 */
            const safeSource = /^[\s\uFEFF]*[=+@-]|^[\t\r\n]/.test(source) ? `'${source}` : source;
            return [
                index,
                row.kind === 'reserved' ? 'reserve' : 'image',
                row.name,
                row.symbol,
                safeSource,
                hex(row.address),
                hex(row.dataAddress),
                row.width,
                row.height,
                row.dataLength,
                row.recordLength,
                hex(row.endAddress),
                row.cType,
                row.elementBits,
                row.kind === 'image' ? endian[byteOrder] || '' : '',
                row.kind === 'image' ? (row.headerLength ? '数组全部数据(含图片头)' : '仅图片数据(跳过图片头)') : '',
                row.kind === 'image' ? layout.settings.format : '',
                row.kind === 'image' ? layout.settings.scan : ''
            ].map(csvCell).join(',');
        });
        return `\uFEFF${columns}\r\n${lines.join('\r\n')}\r\n`;
    }

    /* 由有效布局 layout 构建三项输出，getPixels 从指定资源读取 RGBA 像素。 */
    async function buildFiles(layout, getPixels) {
        if (layout.issues.length) {
            throw new Error(layout.issues[0]);
        }
        if (!layout.activeCount) {
            throw new Error('至少启用一个资源后才能导出');
        }
        /* 启用的导出行保留页面列表顺序，作为 C 枚举索引。 */
        const rows = layout.rows.filter((row) => row.enabled);
        /* 从 Flash 地址 0 开始写入的完整 BIN 文件。 */
        let bin = null;
        try {
            bin = new Uint8Array(layout.size).fill(layout.fillByte);
        } catch (error) {
            throw new Error(`浏览器无法为 ${layout.size} 字节的 BIN 分配空间：${error.message}`);
        }

        /* 写入已验证的每条记录，保留块直接按指定值填充。 */
        for (const row of rows) {
            if (row.kind === 'reserved') {
                bin.fill(row.fillByte, row.address, row.endAddress);
                continue;
            }
            try {
                /* 源图片解码后的 RGBA 像素。 */
                const pixels = await getPixels(row.resource);
                if (pixels.width !== row.width || pixels.height !== row.height) {
                    throw new Error('解码后的图片尺寸与工程记录不一致');
                }
                /* 按项目设置取模的图片记录。 */
                const record = encodeImage(pixels, layout.settings);
                if (record.length !== row.recordLength) {
                    throw new Error('取模后的长度与地址规划不一致');
                }
                bin.set(record, row.address);
            } catch (error) {
                throw new Error(`${row.name}：${error.message}`);
            }
        }

        return {
            bin,
            header: buildHeader(layout, rows),
            csv: buildCsv(layout, rows),
            binName: layout.binName
        };
    }

    globalThis.ImageConverter = Object.freeze({ formats, scans, presets, defaults, parseNumber, hex, imageSymbol, validName, plan, decodePixels, encodeImage, buildFiles });
})();
