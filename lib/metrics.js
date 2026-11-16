function parseCpuCounters(text) {
    if (typeof text !== "string")
        return null;

    const line = text.split(/\r?\n/).find((entry) => /^cpu(?:\s|$)/.test(entry));
    if (!line)
        return null;

    const values = line.trim().split(/\s+/).slice(1).map((value) => Number.parseInt(value, 10));
    if (values.length < 4 || values.some((value) => !Number.isFinite(value) || value < 0))
        return null;

    // Linux already accounts guest and guest_nice in user and nice.
    const total = values.slice(0, 8).reduce((sum, value) => sum + value, 0);
    const idle = values[3] + (values[4] || 0);
    return { total, idle };
}

function calculateCpuPercent(previous, current) {
    if (!previous || !current)
        return null;

    const totalDelta = current.total - previous.total;
    const idleDelta = current.idle - previous.idle;
    if (totalDelta <= 0 || idleDelta < 0 || idleDelta > totalDelta)
        return null;

    const busyPercent = ((totalDelta - idleDelta) / totalDelta) * 100;
    return Math.max(0, Math.min(100, busyPercent));
}

function parseMemoryInfo(text) {
    if (typeof text !== "string")
        return null;

    const values = {};
    for (const line of text.split(/\r?\n/)) {
        const match = /^([A-Za-z_]+):\s*(\d+)\s*(?:kB)?\s*$/.exec(line);
        if (match)
            values[match[1]] = Number.parseInt(match[2], 10);
    }

    const totalKiB = values.MemTotal;
    if (!Number.isFinite(totalKiB) || totalKiB <= 0)
        return null;

    let availableKiB = values.MemAvailable;
    if (!Number.isFinite(availableKiB)) {
        const freeKiB = values.MemFree || 0;
        const buffersKiB = values.Buffers || 0;
        const cachedKiB = values.Cached || 0;
        const reclaimableKiB = values.SReclaimable || 0;
        const sharedKiB = values.Shmem || 0;
        availableKiB = freeKiB + buffersKiB + cachedKiB + reclaimableKiB - sharedKiB;
    }

    availableKiB = Math.max(0, Math.min(totalKiB, availableKiB));
    const totalBytes = totalKiB * 1024;
    const availableBytes = availableKiB * 1024;
    const usedBytes = totalBytes - availableBytes;

    return {
        totalBytes,
        availableBytes,
        usedBytes,
        percent: (usedBytes / totalBytes) * 100
    };
}

function calculateStorageUsage(totalBytes, freeBytes) {
    if (!Number.isFinite(totalBytes) || totalBytes <= 0 ||
        !Number.isFinite(freeBytes) || freeBytes < 0 || freeBytes > totalBytes)
        return null;

    const usedBytes = totalBytes - freeBytes;
    return { totalBytes, freeBytes, usedBytes, percent: usedBytes / totalBytes * 100 };
}

function parseNetworkStats(text) {
    if (typeof text !== "string")
        return {};

    const interfaces = {};
    for (const line of text.split(/\r?\n/)) {
        const colon = line.indexOf(":");
        if (colon < 0)
            continue;

        const name = line.slice(0, colon).trim();
        const fields = line.slice(colon + 1).trim().split(/\s+/).map((value) => Number.parseInt(value, 10));
        if (!name || fields.length < 9 || fields.some((value) => !Number.isFinite(value) || value < 0))
            continue;

        interfaces[name] = {
            receiveBytes: fields[0],
            transmitBytes: fields[8]
        };
    }
    return interfaces;
}

function selectNetworkInterface(routeText, networkText) {
    const interfaces = parseNetworkStats(networkText);
    const routes = [];

    if (typeof routeText === "string") {
        for (const line of routeText.split(/\r?\n/).slice(1)) {
            const fields = line.trim().split(/\s+/);
            if (fields.length < 7 || Number.parseInt(fields[1], 16) !== 0)
                continue;

            const flags = Number.parseInt(fields[3], 16);
            const metric = Number.parseInt(fields[6], 10);
            const name = fields[0];
            if ((flags & 1) !== 1 || !Number.isFinite(metric) || name === "lo" || !interfaces[name])
                continue;

            routes.push({ name, metric });
        }
    }

    if (routes.length > 0) {
        routes.sort((left, right) => left.metric - right.metric);
        return routes[0].name;
    }

    const candidates = Object.keys(interfaces).filter((name) => name !== "lo");
    if (candidates.length === 0)
        return null;

    candidates.sort((left, right) => {
        const leftTotal = interfaces[left].receiveBytes + interfaces[left].transmitBytes;
        const rightTotal = interfaces[right].receiveBytes + interfaces[right].transmitBytes;
        return rightTotal - leftTotal;
    });
    return candidates[0];
}

function calculateNetworkRates(previous, current, elapsedSeconds) {
    if (!previous || !current || !Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0)
        return null;

    const receiveDelta = current.receiveBytes - previous.receiveBytes;
    const transmitDelta = current.transmitBytes - previous.transmitBytes;
    if (receiveDelta < 0 || transmitDelta < 0)
        return null;

    return {
        downloadBytesPerSecond: receiveDelta / elapsedSeconds,
        uploadBytesPerSecond: transmitDelta / elapsedSeconds
    };
}

function temperatureSensorScore(sensor) {
    if (!sensor || !sensor.path)
        return -1;

    const name = String(sensor.name || "").toLowerCase();
    const label = String(sensor.label || "").toLowerCase();
    const combined = `${name} ${label}`;
    if (/gpu|nvidia|amdgpu|nouveau|radeon/.test(combined))
        return -1;

    if (/x86_pkg_temp|package(?:\s*id)?/.test(label) || /x86_pkg_temp/.test(name))
        return 100;
    if (/\btctl\b|\btdie\b/.test(label))
        return 95;
    if (/cpu|processor/.test(label))
        return 90;
    if (/core\s*\d*/.test(label))
        return 70;
    if (/coretemp|k10temp|zenpower|cpu[_-]?thermal|acpitz/.test(name))
        return 60;
    return -1;
}

function selectCpuTemperatureSensor(sensors) {
    if (!Array.isArray(sensors))
        return null;

    let selected = null;
    let selectedScore = -1;
    for (const sensor of sensors) {
        const score = temperatureSensorScore(sensor);
        if (score > selectedScore) {
            selected = sensor;
            selectedScore = score;
        }
    }
    return selectedScore < 0 ? null : selected;
}

function parseTemperature(text) {
    if (typeof text !== "string")
        return null;

    const raw = Number.parseFloat(text.trim());
    if (!Number.isFinite(raw))
        return null;

    const celsius = Math.abs(raw) > 1000 ? raw / 1000 : raw;
    if (celsius < -50 || celsius > 150)
        return null;
    return celsius;
}

function formatRate(bytesPerSecond) {
    if (!Number.isFinite(bytesPerSecond) || bytesPerSecond < 0)
        return "—";
    if (bytesPerSecond < 1024)
        return `${Math.round(bytesPerSecond)} B/s`;

    const units = ["KiB/s", "MiB/s", "GiB/s"];
    let value = bytesPerSecond;
    let unitIndex = -1;
    do {
        value /= 1024;
        unitIndex += 1;
    } while (value >= 1024 && unitIndex < units.length - 1);

    return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatBarGraph(values, width = 6) {
    if (!Array.isArray(values) || !Number.isInteger(width) || width <= 0)
        return "";

    const samples = values
        .filter((value) => Number.isFinite(value))
        .slice(-width)
        .map((value) => Math.max(0, Math.min(100, value)));
    if (samples.length === 0)
        return "";

    const bars = "▁▂▃▄▅▆▇█";
    return samples.map((value) => {
        const index = Math.round((value / 100) * (bars.length - 1));
        return bars[index];
    }).join("");
}

module.exports = {
    calculateCpuPercent,
    calculateNetworkRates,
    calculateStorageUsage,
    formatBarGraph,
    formatRate,
    parseCpuCounters,
    parseMemoryInfo,
    parseNetworkStats,
    parseTemperature,
    selectCpuTemperatureSensor,
    selectNetworkInterface
};
