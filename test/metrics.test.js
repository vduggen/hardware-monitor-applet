const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const metrics = require("../lib/metrics");

const fixturesPath = path.join(__dirname, "fixtures");
const fixture = (name) => fs.readFileSync(path.join(fixturesPath, name), "utf8");
const jsonFixture = (name) => JSON.parse(fixture(name));

test("parses aggregate CPU counters and calculates busy percentage", () => {
    const before = metrics.parseCpuCounters(fixture("proc-stat-before.txt"));
    const after = metrics.parseCpuCounters(fixture("proc-stat-after.txt"));

    assert.deepEqual(before, { total: 1000, idle: 850 });
    assert.deepEqual(after, { total: 1200, idle: 950 });
    assert.equal(metrics.calculateCpuPercent(before, after), 50);
});

test("CPU usage waits for a baseline and rejects resets or empty input", () => {
    const counters = { total: 10, idle: 5 };
    assert.equal(metrics.parseCpuCounters("intr 10\n"), null);
    assert.equal(metrics.calculateCpuPercent(null, counters), null);
    assert.equal(metrics.calculateCpuPercent(counters, counters), null);
    assert.equal(metrics.calculateCpuPercent({ total: 20, idle: 10 }, counters), null);
});

test("parses memory use using MemAvailable in bytes and percent", () => {
    const memory = metrics.parseMemoryInfo(fixture("meminfo.txt"));
    assert.equal(memory.totalBytes, 16384000 * 1024);
    assert.equal(memory.availableBytes, 8192000 * 1024);
    assert.equal(memory.usedBytes, 8192000 * 1024);
    assert.equal(memory.percent, 50);
});

test("uses a conservative available-memory fallback if MemAvailable is absent", () => {
    const memory = metrics.parseMemoryInfo(fixture("meminfo-fallback.txt"));
    assert.equal(memory.availableBytes, (100000 + 20000 + 300000 + 10000 - 5000) * 1024);
    assert.equal(metrics.parseMemoryInfo("MemFree: 10 kB\n"), null);
});

test("parses network counters and prefers the lowest-metric active default route", () => {
    const stats = metrics.parseNetworkStats(fixture("net-dev.txt"));
    assert.equal(stats.wlp2s0.receiveBytes, 8000000);
    assert.equal(stats.wlp2s0.transmitBytes, 4000000);
    assert.equal(metrics.selectNetworkInterface(fixture("proc-route.txt"), fixture("net-dev.txt")), "wlp2s0");
});

test("selects the busiest non-loopback interface when no route is available", () => {
    assert.equal(metrics.selectNetworkInterface("", fixture("net-dev.txt")), "wlp2s0");
    assert.equal(metrics.selectNetworkInterface("", fixture("net-dev-empty.txt")), null);
});

test("calculates current network rates and handles counter resets", () => {
    const before = metrics.parseNetworkStats(fixture("net-dev.txt")).wlp2s0;
    const after = metrics.parseNetworkStats(fixture("net-dev-after.txt")).wlp2s0;
    assert.deepEqual(metrics.calculateNetworkRates(before, after, 2), {
        downloadBytesPerSecond: 200000,
        uploadBytesPerSecond: 100000
    });
    assert.equal(metrics.calculateNetworkRates(after, before, 1), null);
    assert.equal(metrics.calculateNetworkRates(null, after, 1), null);
});

test("selects a CPU package sensor, ignores GPU sensors and tolerates no sensors", () => {
    const sensors = jsonFixture("temperature-sensors.json");
    assert.equal(metrics.selectCpuTemperatureSensor(sensors), sensors[0]);
    assert.equal(metrics.selectCpuTemperatureSensor(jsonFixture("no-temperature-sensors.json")), null);
    assert.equal(metrics.selectCpuTemperatureSensor([
        { path: "/sys/class/hwmon/hwmon1/temp1_input", name: "amdgpu", label: "edge" }
    ]), null);
});

test("parses millidegrees and reports unavailable temperature readings", () => {
    assert.equal(metrics.parseTemperature(fixture("cpu-temperature.txt")), 56);
    assert.equal(metrics.parseTemperature("42.5"), 42.5);
    assert.equal(metrics.parseTemperature(fixture("no-cpu-temperature.txt")), null);
    assert.equal(metrics.parseTemperature(null), null);
});

test("formats rates compactly and leaves unavailable rates explicit", () => {
    assert.equal(metrics.formatRate(400), "400 B/s");
    assert.equal(metrics.formatRate(1536), "1.5 KiB/s");
    assert.equal(metrics.formatRate(2 * 1024 * 1024), "2.0 MiB/s");
    assert.equal(metrics.formatRate(null), "—");
});

test("calculates occupied filesystem space in bytes and percent", () => {
    const GiB = 1024 ** 3;
    assert.deepEqual(metrics.calculateStorageUsage(100 * GiB, 25 * GiB), {
        totalBytes: 100 * GiB, freeBytes: 25 * GiB,
        usedBytes: 75 * GiB, percent: 75
    });
    assert.equal(metrics.calculateStorageUsage(100, 0).percent, 100);
    assert.equal(metrics.calculateStorageUsage(100, 100).percent, 0);
});

test("rejects missing or invalid filesystem capacity", () => {
    for (const [total, free] of [[0, 0], [100, -1], [100, 101], [NaN, 0], [100, null], [Infinity, 0]])
        assert.equal(metrics.calculateStorageUsage(total, free), null);
});

test("formats recent CPU and memory samples as vertical bar graphs", () => {
    assert.equal(metrics.formatBarGraph([0, 10, 30, 60, 100]), "▁▂▃▅█");
    assert.equal(metrics.formatBarGraph([-20, 120]), "▁█");
    assert.equal(metrics.formatBarGraph([0, 25, 50], 2), "▃▅");
    assert.equal(metrics.formatBarGraph([null, NaN, Infinity]), "");
    assert.equal(metrics.formatBarGraph([10], 0), "");
});
