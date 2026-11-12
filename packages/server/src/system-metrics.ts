import { readFile } from 'node:fs/promises';
import { statfs } from 'node:fs/promises';
import { loadavg } from 'node:os';
import { memoryUsage } from 'node:process';

export interface SystemMetrics {
  at: string;
  cpu: { usagePercent: number; load1: number; processPercent: number };
  memory: { totalBytes: number; usedBytes: number; availableBytes: number; usedPercent: number; processRssBytes: number };
  network: { rxBytes: number; txBytes: number; rxBytesPerSec: number; txBytesPerSec: number };
  disk: { totalBytes: number; usedBytes: number; availableBytes: number; usedPercent: number };
}

interface CpuSample { total: number; idle: number; at: number }
interface NetworkSample { rx: number; tx: number; at: number }
interface ProcessSample { cpuMicros: number; at: number }

/** Host metrics are read from procfs/statfs and never execute shell commands. */
export class SystemMetricsReader {
  private cpu: CpuSample | undefined;
  private network: NetworkSample | undefined;
  private process: ProcessSample | undefined;

  constructor(private readonly diskPath: string) {}

  async read(): Promise<SystemMetrics> {
    const now = Date.now();
    const [procStat, memInfo, netDev, disk] = await Promise.all([
      readFile('/proc/stat', 'utf8'),
      readFile('/proc/meminfo', 'utf8'),
      readFile('/proc/net/dev', 'utf8'),
      statfs(this.diskPath),
    ]);
    const cpu = parseCpu(procStat);
    const memory = parseMemory(memInfo);
    const network = parseNetwork(netDev);
    const cpuPercent = this.cpu === undefined ? 0 : percentDelta(cpu.total - this.cpu.total - (cpu.idle - this.cpu.idle), cpu.total - this.cpu.total);
    const previousNetwork = this.network;
    const networkSeconds = previousNetwork === undefined ? 0 : Math.max(0.001, (now - previousNetwork.at) / 1000);
    const processCpuMicros = processCpuTotal();
    const processSeconds = this.process === undefined ? 0 : Math.max(0.001, (now - this.process.at) / 1000);
    const processPercent = this.process === undefined ? 0 : Math.max(0, Math.min(100, ((processCpuMicros - this.process.cpuMicros) / 1_000_000 / processSeconds) * 100));
    this.cpu = { ...cpu, at: now };
    this.network = { ...network, at: now };
    this.process = { cpuMicros: processCpuMicros, at: now };
    const totalDisk = Number(disk.blocks) * Number(disk.bsize);
    const availableDisk = Number(disk.bavail) * Number(disk.bsize);
    const usedDisk = Math.max(0, totalDisk - Number(disk.bfree) * Number(disk.bsize));
    return {
      at: new Date(now).toISOString(),
      cpu: { usagePercent: round(cpuPercent), load1: loadavg()[0] ?? 0, processPercent: round(processPercent) },
      memory: { ...memory, processRssBytes: memoryUsage().rss },
      network: { rxBytes: network.rx, txBytes: network.tx, rxBytesPerSec: round(this.networkRate(network.rx, previousNetwork?.rx, networkSeconds)), txBytesPerSec: round(this.networkRate(network.tx, previousNetwork?.tx, networkSeconds)) },
      disk: { totalBytes: totalDisk, usedBytes: usedDisk, availableBytes: availableDisk, usedPercent: round(totalDisk === 0 ? 0 : (usedDisk / totalDisk) * 100) },
    };
  }

  private networkRate(value: number, previous: number | undefined, seconds: number): number {
    if (previous === undefined || seconds <= 0) return 0;
    return Math.max(0, (value - previous) / seconds);
  }
}

function parseCpu(text: string): Omit<CpuSample, 'at'> {
  const fields = (text.split('\n').find((line) => line.startsWith('cpu ')) ?? '').trim().split(/\s+/).slice(1).map(Number);
  const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
  return { total: fields.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0), idle };
}

function parseMemory(text: string): Omit<SystemMetrics['memory'], 'processRssBytes'> {
  const values = new Map<string, number>();
  for (const line of text.split('\n')) {
    const match = /^(\w+):\s+(\d+)\s+kB$/.exec(line);
    if (match !== null) values.set(match[1] ?? '', Number(match[2]) * 1024);
  }
  const totalBytes = values.get('MemTotal') ?? 0;
  const availableBytes = values.get('MemAvailable') ?? Math.max(0, (values.get('MemFree') ?? 0) + (values.get('Buffers') ?? 0) + (values.get('Cached') ?? 0));
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  return { totalBytes, usedBytes, availableBytes, usedPercent: totalBytes === 0 ? 0 : (usedBytes / totalBytes) * 100 };
}

function parseNetwork(text: string): Omit<NetworkSample, 'at'> {
  let rx = 0;
  let tx = 0;
  for (const line of text.split('\n').slice(2)) {
    const [name, values] = line.trim().split(':');
    if (name === undefined || name === 'lo' || values === undefined) continue;
    const fields = values.trim().split(/\s+/).map(Number);
    rx += fields[0] ?? 0;
    tx += fields[8] ?? 0;
  }
  return { rx, tx };
}

function processCpuTotal(): number {
  const usage = process.cpuUsage();
  return usage.user + usage.system;
}

function percentDelta(active: number, total: number): number {
  return total <= 0 ? 0 : Math.max(0, Math.min(100, (active / total) * 100));
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
