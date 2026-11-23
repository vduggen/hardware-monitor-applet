const Applet = imports.ui.applet;
const ByteArray = imports.byteArray;
const FileUtils = imports.misc.fileUtils;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Mainloop = imports.mainloop;
const PopupMenu = imports.ui.popupMenu;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;

const NETWORK_INTERFACE_RESCAN_SECONDS = 30;
const SENSOR_RESCAN_SECONDS = 60;
const BAR_CHART_SAMPLES = 60;
const STORAGE_REFRESH_SECONDS = 30;

function readText(path) {
    try {
        const file = Gio.File.new_for_path(path);
        const [success, contents] = file.load_contents(null);
        return success ? ByteArray.toString(contents).trim() : null;
    } catch (error) {
        return null;
    }
}

function listChildren(path) {
    let enumerator = null;
    const names = [];
    try {
        const directory = Gio.File.new_for_path(path);
        enumerator = directory.enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = enumerator.next_file(null)) !== null)
            names.push(info.get_name());
    } catch (error) {
        // Missing sysfs trees are normal on machines without exposed sensors.
    } finally {
        if (enumerator) {
            try {
                enumerator.close(null);
            } catch (error) {
                // The enumerator can already be closed after an I/O error.
            }
        }
    }
    return names;
}

class HardwareMonitorApplet extends Applet.Applet {
    constructor(orientation, panelHeight, instanceId, metrics) {
        super(orientation, panelHeight, instanceId);

        this._metricsLib = metrics;
        this._disposed = false;
        this._active = false;
        this._timerIds = [];
        this._networkInterface = null;
        this._lastInterfaceScanAt = 0;
        this._previousNetworkCounters = null;
        this._previousNetworkSampleAt = 0;
        this._previousCpuCounters = null;
        this._cpuHistory = [];
        this._memoryHistory = [];
        this._temperatureSensor = null;
        this._visualStatuses = new WeakMap();
        this._storageRequest = null;
        this._values = {
            cpuPercent: null,
            temperatureC: null,
            memory: null,
            storage: null,
            downloadBytesPerSecond: null,
            uploadBytesPerSecond: null
        };

        this._createPanelIndicators();
        this._createPopup(orientation);
        this.set_applet_tooltip(_("Monitor de hardware"));
        this._refreshTemperatureSensors();
        this._sampleCpu();
        this._sampleMemory();
        this._sampleNetwork();
        this._sampleTemperature();
        this._render();
        this._startTimers();
    }

    _createPanelIndicators() {
        this.actor.add_style_class_name("hardware-monitor-applet");
        this._panelLayout = new St.BoxLayout({ style_class: "hardware-monitor-panel" });
        this._panelLayout.y_align = Clutter.ActorAlign.CENTER;
        this._panelLayout.x_align = Clutter.ActorAlign.CENTER;
        this.actor.add_child(this._panelLayout);

        this._panelCpu = this._createPanelMetric(_("CPU"));
        this._panelMemory = this._createPanelMetric(_("RAM"));
        this._panelStorage = this._createPanelMetric(_("DSK"));
        this._panelTemperature = new St.Label({
            text: "—°C",
            style_class: "hardware-monitor-panel-temperature"
        });
        this._panelNetwork = new St.Label({
            text: "↓— ↑—",
            style_class: "hardware-monitor-panel-network"
        });
        this._panelCpu.reading.add_child(this._panelTemperature);
        this._panelNetwork.y_align = Clutter.ActorAlign.CENTER;
        this._panelLayout.add_child(this._panelNetwork);
    }

    _createPanelMetric(name) {
        const metric = new St.BoxLayout({ style_class: "hardware-monitor-panel-metric" });
        metric.y_align = Clutter.ActorAlign.CENTER;
        const reading = new St.BoxLayout({ vertical: true, style_class: "hardware-monitor-panel-reading" });
        reading.y_align = Clutter.ActorAlign.CENTER;
        const nameLabel = new St.Label({
            text: name.split("").join("\n"),
            style_class: "hardware-monitor-panel-name"
        });
        nameLabel.y_align = Clutter.ActorAlign.CENTER;
        const valueLabel = new St.Label({
            text: `${name} —`,
            style_class: "hardware-monitor-panel-value"
        });
        const gauge = new St.Bin({
            style_class: "hardware-monitor-panel-gauge",
            x_align: St.Align.MIDDLE,
            y_fill: false,
            y_align: St.Align.END
        });
        // St.Bin alignment controls the fill child; the outer box centers the gauge.
        const fill = new St.Widget({ style_class: "hardware-monitor-panel-fill", height: 0 });
        gauge.set_child(fill);

        reading.add_child(valueLabel);
        metric.add(nameLabel, { y_fill: false, y_align: St.Align.MIDDLE });
        metric.add(gauge, { y_fill: false, y_align: St.Align.MIDDLE });
        metric.add(reading, { y_fill: false, y_align: St.Align.MIDDLE });
        this._panelLayout.add_child(metric);

        return { valueLabel, fill, reading };
    }

    _createPopup(orientation) {
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menu.actor.add_style_class_name("hardware-monitor-menu");
        this._menuManager.addMenu(this.menu);
        this.menu.connect("open-state-changed", (menu, open) => {
            if (open) {
                this._popupCpu.graph.queue_repaint();
                this._popupMemory.graph.queue_repaint();
            }
        });

        const section = new PopupMenu.PopupMenuSection();
        const dashboard = new St.BoxLayout({
            vertical: true,
            style_class: "hardware-monitor-dashboard"
        });
        section.actor.add_child(dashboard);
        this.menu.addMenuItem(section);

        const header = new St.BoxLayout({ style_class: "hardware-monitor-header" });
        this._popupTitle = new St.Label({
            text: _("Uso do hardware"),
            style_class: "hardware-monitor-title"
        });
        this._popupTitle.x_expand = true;
        this._popupTitle.y_align = Clutter.ActorAlign.CENTER;
        this._popupLiveStatus = new St.Label({
            text: _("AO VIVO"),
            style_class: "hardware-monitor-live"
        });
        this._popupLiveStatus.y_align = Clutter.ActorAlign.CENTER;
        header.add_child(this._popupTitle);
        header.add_child(this._popupLiveStatus);
        dashboard.add_child(header);

        const primaryMetrics = new St.BoxLayout({
            style_class: "hardware-monitor-metric-row"
        });
        this._popupCpu = this._createMetricCard(_("CPU"), "hardware-monitor-cpu-card");
        this._popupMemory = this._createMetricCard(_("MEMÓRIA"), "hardware-monitor-memory-card");
        primaryMetrics.add_child(this._popupCpu.actor);
        primaryMetrics.add_child(this._popupMemory.actor);
        dashboard.add_child(primaryMetrics);

        this._popupTemperature = this._createWideCard(
            _("TEMPERATURA DA CPU"),
            "hardware-monitor-temperature-value"
        );
        dashboard.add_child(this._popupTemperature.actor);

        this._popupStorage = this._createWideCard(
            _("ARMAZENAMENTO · /"),
            "hardware-monitor-storage-value"
        );
        dashboard.add_child(this._popupStorage.actor);

        this._popupNetwork = this._createNetworkCard();
        dashboard.add_child(this._popupNetwork.actor);
    }

    _createMetricCard(title, styleClass) {
        const card = new St.BoxLayout({
            vertical: true,
            style_class: `hardware-monitor-card ${styleClass}`
        });
        card.x_expand = true;

        const titleLabel = new St.Label({
            text: title,
            style_class: "hardware-monitor-card-title"
        });
        const valueLabel = new St.Label({
            text: "—",
            style_class: "hardware-monitor-card-value"
        });
        const graph = new St.DrawingArea({
            style_class: "hardware-monitor-card-graph",
            height: 55,
            width: 160,
            x_expand: true
        });
        const history = styleClass === "hardware-monitor-cpu-card"
            ? () => this._cpuHistory : () => this._memoryHistory;
        graph.connect("repaint", (area) => this._drawLineGraph(area, history()));
        const detailLabel = new St.Label({
            text: "",
            style_class: "hardware-monitor-card-detail"
        });

        card.add_child(titleLabel);
        card.add_child(valueLabel);
        card.add_child(graph);
        card.add_child(detailLabel);

        return { actor: card, valueLabel, graph, detailLabel };
    }

    _drawLineGraph(area, history) {
        const [width, height] = area.get_surface_size();
        const context = area.get_context();
        try {
            const bottom = height - 3;
            context.setSourceRGBA(0.7, 0.76, 0.9, 0.18);
            context.setLineWidth(1);
            context.moveTo(1, bottom);
            context.lineTo(width - 1, bottom);
            context.stroke();
            if (history.length === 0)
                return;

            const points = history.map((value, index) => ({
                x: 2 + index * (width - 4) / Math.max(1, history.length - 1),
                y: bottom - Math.max(0, Math.min(100, value)) / 100 * (height - 6)
            }));
            if (points.length === 1)
                points.push({ x: width - 2, y: points[0].y });
            context.moveTo(points[0].x, bottom);
            for (const point of points)
                context.lineTo(point.x, point.y);
            context.lineTo(points[points.length - 1].x, bottom);
            context.closePath();
            context.setSourceRGBA(0.4, 0.67, 1, 0.12);
            context.fill();
            context.moveTo(points[0].x, points[0].y);
            for (const point of points.slice(1))
                context.lineTo(point.x, point.y);
            context.setSourceRGBA(0.4, 0.67, 1, 1);
            context.setLineWidth(2);
            context.stroke();
        } finally {
            context.$dispose();
        }
    }

    _createWideCard(title, valueStyleClass) {
        const card = new St.BoxLayout({
            style_class: "hardware-monitor-wide-card"
        });
        const detailColumn = new St.BoxLayout({
            vertical: true,
            style_class: "hardware-monitor-wide-card-copy"
        });
        detailColumn.x_expand = true;
        const titleLabel = new St.Label({
            text: title,
            style_class: "hardware-monitor-card-title"
        });
        const detailLabel = new St.Label({
            text: _("Sensor detectado automaticamente"),
            style_class: "hardware-monitor-card-detail"
        });
        const valueLabel = new St.Label({
            text: "—°C",
            style_class: `hardware-monitor-wide-card-value ${valueStyleClass}`
        });
        valueLabel.x_expand = false;
        valueLabel.x_align = Clutter.ActorAlign.END;
        valueLabel.y_align = Clutter.ActorAlign.CENTER;
        detailColumn.add_child(titleLabel);
        detailColumn.add_child(detailLabel);
        card.add_child(detailColumn);
        card.add_child(valueLabel);

        return { actor: card, valueLabel, detailLabel };
    }

    _createNetworkCard() {
        const card = new St.BoxLayout({
            vertical: true,
            style_class: "hardware-monitor-wide-card hardware-monitor-network-card"
        });
        const header = new St.BoxLayout({
            style_class: "hardware-monitor-network-header"
        });
        const titleLabel = new St.Label({
            text: _("REDE"),
            style_class: "hardware-monitor-card-title"
        });
        const interfaceLabel = new St.Label({
            text: _("Interface automática"),
            style_class: "hardware-monitor-card-detail"
        });
        interfaceLabel.x_expand = true;
        interfaceLabel.x_align = Clutter.ActorAlign.END;
        header.add_child(titleLabel);
        header.add_child(interfaceLabel);
        card.add_child(header);

        const rates = new St.BoxLayout({
            style_class: "hardware-monitor-network-rates"
        });
        const download = this._createNetworkRate(_("DOWNLOAD"));
        const upload = this._createNetworkRate(_("UPLOAD"));
        rates.add_child(download.actor);
        rates.add_child(upload.actor);
        card.add_child(rates);

        return {
            actor: card,
            interfaceLabel,
            downloadValue: download.valueLabel,
            uploadValue: upload.valueLabel
        };
    }

    _createNetworkRate(title) {
        const metric = new St.BoxLayout({
            vertical: true,
            style_class: "hardware-monitor-network-rate"
        });
        metric.x_expand = true;
        const titleLabel = new St.Label({
            text: title,
            style_class: "hardware-monitor-card-detail"
        });
        const valueLabel = new St.Label({
            text: "—",
            style_class: "hardware-monitor-network-value"
        });
        metric.add_child(titleLabel);
        metric.add_child(valueLabel);
        return { actor: metric, valueLabel };
    }

    on_applet_clicked(event) {
        this.menu.toggle();
    }

    set_applet_enabled(enabled) {
        const wasEnabled = this._applet_enabled;
        super.set_applet_enabled(enabled);
        if (enabled && !wasEnabled) {
            this._refreshTemperatureSensors();
            this._sampleCpu();
            this._sampleMemory();
            this._sampleNetwork();
            this._sampleTemperature();
        }

        if (enabled)
            this._startTimers();
        else
            this._stopTimers();
    }

    on_applet_removed_from_panel() {
        this._dispose();
    }

    on_applet_reloaded() {
        this._dispose();
    }

    _dispose() {
        if (this._disposed)
            return;

        this._disposed = true;
        this._stopTimers();
        if (this.menu) {
            this._menuManager.removeMenu(this.menu);
            this.menu.destroy();
            this.menu = null;
        }
    }

    _startTimers() {
        if (this._disposed || this._active)
            return;

        this._active = true;
        this._sampleStorage();
        this._timerIds.push(Mainloop.timeout_add_seconds(STORAGE_REFRESH_SECONDS, () => {
            this._sampleStorage();
            return this._active;
        }));
        this._timerIds.push(Mainloop.timeout_add_seconds(1, () => {
            this._sampleCpu();
            this._sampleNetwork();
            return this._active;
        }));
        this._timerIds.push(Mainloop.timeout_add_seconds(3, () => {
            this._sampleMemory();
            return this._active;
        }));
        this._timerIds.push(Mainloop.timeout_add_seconds(5, () => {
            this._sampleTemperature();
            return this._active;
        }));
        this._timerIds.push(Mainloop.timeout_add_seconds(SENSOR_RESCAN_SECONDS, () => {
            this._refreshTemperatureSensors();
            this._sampleTemperature();
            return this._active;
        }));
    }

    _stopTimers() {
        this._active = false;
        if (this._storageRequest) {
            this._storageRequest.cancel();
            this._storageRequest = null;
        }
        for (const timerId of this._timerIds) {
            if (timerId > 0)
                Mainloop.source_remove(timerId);
        }
        this._timerIds = [];
        this._previousCpuCounters = null;
        this._cpuHistory = [];
        this._memoryHistory = [];
        this._previousNetworkCounters = null;
        this._previousNetworkSampleAt = 0;
        this._lastInterfaceScanAt = 0;
        this._values.cpuPercent = null;
        this._values.downloadBytesPerSecond = null;
        this._values.uploadBytesPerSecond = null;
    }

    _sampleStorage() {
        if (this._storageRequest || this._disposed || !this._active)
            return;

        const request = new Gio.Cancellable();
        this._storageRequest = request;
        Gio.File.new_for_path("/").query_filesystem_info_async(
            "filesystem::size,filesystem::free",
            GLib.PRIORITY_DEFAULT,
            request,
            (file, result) => {
                let storage = null;
                try {
                    const info = file.query_filesystem_info_finish(result);
                    if (info.has_attribute("filesystem::size") && info.has_attribute("filesystem::free")) {
                        storage = this._metricsLib.calculateStorageUsage(
                            info.get_attribute_uint64("filesystem::size"),
                            info.get_attribute_uint64("filesystem::free")
                        );
                    }
                } catch (error) {
                    // An unavailable filesystem is displayed as unknown, not zero.
                }
                if (this._storageRequest !== request)
                    return;
                this._storageRequest = null;
                if (this._disposed || !this._active)
                    return;
                this._values.storage = storage;
                this._render();
            }
        );
    }

    _sampleCpu() {
        const text = readText("/proc/stat");
        const current = this._metricsLib.parseCpuCounters(text);
        this._values.cpuPercent = this._metricsLib.calculateCpuPercent(this._previousCpuCounters, current);
        this._previousCpuCounters = current;
        this._render();
    }

    _sampleMemory() {
        this._values.memory = this._metricsLib.parseMemoryInfo(readText("/proc/meminfo"));
        if (Number.isFinite(this._values.cpuPercent) && this._values.memory) {
            this._cpuHistory.push(this._values.cpuPercent);
            this._memoryHistory.push(this._values.memory.percent);
            if (this._cpuHistory.length > BAR_CHART_SAMPLES) {
                this._cpuHistory.shift();
                this._memoryHistory.shift();
            }
        }
        this._render();
    }

    _sampleNetwork() {
        const networkText = readText("/proc/net/dev");
        const interfaces = this._metricsLib.parseNetworkStats(networkText);
        const now = GLib.get_monotonic_time() / 1000000;

        if (now - this._lastInterfaceScanAt >= NETWORK_INTERFACE_RESCAN_SECONDS) {
            const routeText = readText("/proc/net/route");
            const selected = this._metricsLib.selectNetworkInterface(routeText, networkText);
            if (selected !== this._networkInterface) {
                this._networkInterface = selected;
                this._previousNetworkCounters = null;
                this._previousNetworkSampleAt = 0;
            }
            this._lastInterfaceScanAt = now;
        }

        const current = this._networkInterface ? interfaces[this._networkInterface] : null;
        if (!current) {
            this._values.downloadBytesPerSecond = null;
            this._values.uploadBytesPerSecond = null;
            this._previousNetworkCounters = null;
            this._previousNetworkSampleAt = 0;
            this._render();
            return;
        }

        const elapsed = this._previousNetworkSampleAt > 0 ? now - this._previousNetworkSampleAt : 0;
        const rates = this._metricsLib.calculateNetworkRates(this._previousNetworkCounters, current, elapsed);
        this._values.downloadBytesPerSecond = rates ? rates.downloadBytesPerSecond : null;
        this._values.uploadBytesPerSecond = rates ? rates.uploadBytesPerSecond : null;
        this._previousNetworkCounters = current;
        this._previousNetworkSampleAt = now;
        this._render();
    }

    _discoverTemperatureSensors() {
        const sensors = [];
        const hwmonRoot = "/sys/class/hwmon";

        for (const directoryName of listChildren(hwmonRoot)) {
            const directoryPath = `${hwmonRoot}/${directoryName}`;
            const name = readText(`${directoryPath}/name`) || "";
            for (const childName of listChildren(directoryPath)) {
                const match = /^temp(\d+)_input$/.exec(childName);
                if (!match)
                    continue;

                sensors.push({
                    path: `${directoryPath}/${childName}`,
                    name,
                    label: readText(`${directoryPath}/temp${match[1]}_label`) || "",
                    source: "hwmon"
                });
            }
        }

        const thermalRoot = "/sys/class/thermal";
        for (const directoryName of listChildren(thermalRoot)) {
            if (!/^thermal_zone\d+$/.test(directoryName))
                continue;

            const directoryPath = `${thermalRoot}/${directoryName}`;
            sensors.push({
                path: `${directoryPath}/temp`,
                name: "thermal",
                label: readText(`${directoryPath}/type`) || "",
                source: "thermal"
            });
        }
        return sensors;
    }

    _refreshTemperatureSensors() {
        const sensors = this._discoverTemperatureSensors();
        this._temperatureSensor = this._metricsLib.selectCpuTemperatureSensor(sensors);
        if (!this._temperatureSensor)
            this._values.temperatureC = null;
    }

    _sampleTemperature() {
        const text = this._temperatureSensor ? readText(this._temperatureSensor.path) : null;
        this._values.temperatureC = this._metricsLib.parseTemperature(text);
        this._render();
    }

    _formatPercent(value) {
        return Number.isFinite(value) ? `${Math.round(value)}%` : "—";
    }

    _formatTemperature(value) {
        return Number.isFinite(value) ? `${Math.round(value)}°C` : "—°C";
    }

    _formatMemory(memory) {
        if (!memory)
            return "—";
        return `${this._formatPercent(memory.percent)} · ${(memory.usedBytes / (1024 ** 3)).toFixed(1)} / ${(memory.totalBytes / (1024 ** 3)).toFixed(1)} GiB`;
    }

    _setVisualStatus(actor, status) {
        const previousStatus = this._visualStatuses.get(actor);
        if (previousStatus === status)
            return;

        if (previousStatus)
            actor.remove_style_class_name(`hardware-monitor-status-${previousStatus}`);
        actor.add_style_class_name(`hardware-monitor-status-${status}`);
        this._visualStatuses.set(actor, status);
    }

    _usageStatus(value) {
        if (!Number.isFinite(value))
            return "unavailable";
        if (value >= 90)
            return "critical";
        if (value >= 70)
            return "warning";
        return "normal";
    }

    _temperatureStatus(value) {
        if (!Number.isFinite(value))
            return "unavailable";
        if (value >= 80)
            return "critical";
        if (value >= 60)
            return "warning";
        return "normal";
    }

    _render() {
        const cpu = this._formatPercent(this._values.cpuPercent);
        const temperature = this._formatTemperature(this._values.temperatureC);
        const memory = this._formatMemory(this._values.memory);
        const memoryPercent = this._values.memory ? this._formatPercent(this._values.memory.percent) : "—";
        const storage = this._values.storage;
        const storagePercent = storage ? this._formatPercent(storage.percent) : "—";
        const download = this._metricsLib.formatRate(this._values.downloadBytesPerSecond);
        const upload = this._metricsLib.formatRate(this._values.uploadBytesPerSecond);

        this._panelCpu.valueLabel.set_text(cpu);
        this._panelCpu.fill.set_height(Number.isFinite(this._values.cpuPercent)
            ? Math.round(this._values.cpuPercent / 100 * 16) : 0);
        this._setVisualStatus(this._panelCpu.fill, this._usageStatus(this._values.cpuPercent));
        this._panelMemory.valueLabel.set_text(memoryPercent);
        this._panelMemory.fill.set_height(this._values.memory
            ? Math.round(this._values.memory.percent / 100 * 16) : 0);
        this._setVisualStatus(
            this._panelMemory.fill,
            this._usageStatus(this._values.memory ? this._values.memory.percent : null)
        );
        this._panelStorage.valueLabel.set_text(storagePercent);
        this._panelStorage.fill.set_height(storage ? Math.round(storage.percent / 100 * 16) : 0);
        this._setVisualStatus(
            this._panelStorage.fill,
            this._usageStatus(storage ? storage.percent : null)
        );
        this._panelTemperature.set_text(temperature);
        const temperatureStatus = this._temperatureStatus(this._values.temperatureC);
        this._setVisualStatus(this._panelTemperature, temperatureStatus);
        this._panelNetwork.set_text(`↓${download} ↑${upload}`);
        this.set_applet_tooltip(`CPU ${cpu} · ${temperature} · RAM ${memory} · Disco / ${storagePercent} · ↓${download} ↑${upload}`);

        if (!this.menu)
            return;
        this._popupCpu.valueLabel.set_text(cpu);
        if (this.menu.isOpen)
            this._popupCpu.graph.queue_repaint();
        this._popupCpu.detailLabel.set_text(_("Uso total do processador"));
        this._popupMemory.valueLabel.set_text(memoryPercent);
        if (this.menu.isOpen)
            this._popupMemory.graph.queue_repaint();
        this._popupMemory.detailLabel.set_text(memory);
        this._popupStorage.valueLabel.set_text(storagePercent);
        this._popupStorage.detailLabel.set_text(storage
            ? `${(storage.usedBytes / 1024 ** 3).toFixed(1)} / ${(storage.totalBytes / 1024 ** 3).toFixed(1)} GiB · ${(storage.freeBytes / 1024 ** 3).toFixed(1)} GiB livres`
            : _("Armazenamento indisponível"));
        this._popupTemperature.valueLabel.set_text(temperature);
        this._setVisualStatus(this._popupTemperature.valueLabel, temperatureStatus);
        this._popupTemperature.detailLabel.set_text(
            this._temperatureSensor
                ? (this._temperatureSensor.label || this._temperatureSensor.name)
                : _("Sensor indisponível")
        );
        this._popupNetwork.interfaceLabel.set_text(this._networkInterface || _("Interface automática"));
        this._popupNetwork.downloadValue.set_text(download);
        this._popupNetwork.uploadValue.set_text(upload);
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    const metrics = FileUtils.requireModule("lib/metrics.js", metadata.path, metadata, "applet");
    return new HardwareMonitorApplet(orientation, panelHeight, instanceId, metrics);
}
