(() => {
    "use strict";

    /* ZIP32 尺寸和偏移字段的保留值，达到该值时需要 ZIP64。 */
    const zip64Marker = 0xFFFFFFFF;
    /* 文件名由 UTF-8 编码，解压软件通过通用标志的第 11 位识别。 */
    const utf8Flag = 0x0800;
    /* 固定使用最早的 DOS 日期 1980-01-01，便于重复导出时比较结果。 */
    const dosDate = 0x0021;
    /* 用于编码文件名和文本内容。 */
    const utf8 = new TextEncoder();
    /* 预先计算 CRC-32 查找表供每个归档文件使用。 */
    const crcTable = new Uint32Array(256);

    /* 查表索引对应一个可能的字节值。 */
    for (let index = 0; index < crcTable.length; index += 1) {
        /* 当前查表项的初始余数。 */
        let remainder = index;
        /* 每次处理余数的最低位，迭代 8 次。 */
        let bit = 0;
        for (; bit < 8; bit += 1) {
            if (remainder & 1) {
                remainder = (remainder >>> 1) ^ 0xEDB88320;
            } else {
                remainder >>>= 1;
            }
        }
        crcTable[index] = remainder;
    }

    /* 计算 data 字节数组的 ZIP CRC-32 校验值。 */
    function crc32(data) {
        /* ZIP CRC-32 的初始寄存器值。 */
        let crc = 0xFFFFFFFF;
        /* 输入数据的字节索引。 */
        let index = 0;
        for (; index < data.length; index += 1) {
            crc = (crc >>> 8) ^ crcTable[(crc ^ data[index]) & 0xFF];
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    /* 将 entries 中的文件名与二进制或文本数据封装成不压缩的 ZIP。 */
    function create(entries) {
        if (!Array.isArray(entries) || entries.length === 0 || entries.length >= 0xFFFF) {
            throw new Error("ZIP 文件数量超出范围");
        }

        /* 按归档顺序收集文件头、文件名和数据。 */
        const fileParts = [];
        /* 收集归档末尾使用的中央目录条目。 */
        const directoryParts = [];
        /* Windows 解压时会视为相同的文件名集合。 */
        const names = new Set();
        /* 下一条文件头的偏移，单位为字节。 */
        let offset = 0;
        /* 中央目录的总长度，单位为字节。 */
        let directorySize = 0;

        /* 逐个校验和写入待归档文件。 */
        for (const entry of entries) {
            /* 归档内的单层文件名。 */
            const name = entry?.name;
            if (typeof name !== "string" || !name || /[<>:"/\\|?*\x00-\x1F\x7F]|\p{Surrogate}|[. ]$/u.test(name)) {
                throw new Error("ZIP 中的文件名无效");
            }
            /* 用于检查大小写不敏感的重名。 */
            const nameKey = name.toLowerCase();
            if (names.has(nameKey)) {
                throw new Error(`ZIP 中的文件名重复：${name}`);
            }
            names.add(nameKey);

            /* 写入 ZIP 的 UTF-8 文件名字节。 */
            const nameBytes = utf8.encode(name);
            /* 写入 ZIP 的原始文件字节。 */
            const data = typeof entry.data === "string" ? utf8.encode(entry.data) : entry.data;
            if (!(data instanceof Uint8Array) || nameBytes.length > 0xFFFF || data.length >= zip64Marker) {
                throw new Error(`ZIP 条目超出格式限制：${name}`);
            }

            /* 本条目结束后下一条文件头所在的偏移，单位为字节。 */
            const nextOffset = offset + 30 + nameBytes.length + data.length;
            directorySize += 46 + nameBytes.length;
            if (nextOffset + directorySize + 22 >= zip64Marker) {
                throw new Error("导出文件超出 ZIP32 容量限制");
            }

            /* 文件数据的 CRC-32，文件头和中央目录均使用该值。 */
            const checksum = crc32(data);
            /* 文件头固定部分，压缩方式和额外字段长度均为 0。 */
            const localHeader = new DataView(new ArrayBuffer(30));
            localHeader.setUint32(0, 0x04034B50, true);
            localHeader.setUint16(4, 20, true);
            localHeader.setUint16(6, utf8Flag, true);
            localHeader.setUint16(12, dosDate, true);
            localHeader.setUint32(14, checksum, true);
            localHeader.setUint32(18, data.length, true);
            localHeader.setUint32(22, data.length, true);
            localHeader.setUint16(26, nameBytes.length, true);
            fileParts.push(localHeader.buffer, nameBytes, data);

            /* 中央目录条目的固定部分，包含文件头偏移。 */
            const directoryHeader = new DataView(new ArrayBuffer(46));
            directoryHeader.setUint32(0, 0x02014B50, true);
            directoryHeader.setUint16(4, 20, true);
            directoryHeader.setUint16(6, 20, true);
            directoryHeader.setUint16(8, utf8Flag, true);
            directoryHeader.setUint16(14, dosDate, true);
            directoryHeader.setUint32(16, checksum, true);
            directoryHeader.setUint32(20, data.length, true);
            directoryHeader.setUint32(24, data.length, true);
            directoryHeader.setUint16(28, nameBytes.length, true);
            directoryHeader.setUint32(42, offset, true);
            directoryParts.push(directoryHeader.buffer, nameBytes);
            offset = nextOffset;
        }

        /* 中央目录结束记录包含条目数量、长度和起始偏移。 */
        const end = new DataView(new ArrayBuffer(22));
        end.setUint32(0, 0x06054B50, true);
        end.setUint16(8, entries.length, true);
        end.setUint16(10, entries.length, true);
        end.setUint32(12, directorySize, true);
        end.setUint32(16, offset, true);
        return new Blob([...fileParts, ...directoryParts, end.buffer], { type: "application/zip" });
    }

    window.ZipExport = Object.freeze({ create });
})();
