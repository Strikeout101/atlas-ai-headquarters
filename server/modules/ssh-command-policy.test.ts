import { describe, expect, it } from "vitest";
import { classifySshCommand } from "./ssh-command-policy.ts";

const readOnly = [
  "uptime",
  "df -h",
  "free -m",
  "systemctl status pihole-FTL --no-pager",
  "sudo systemctl status nginx",
  "journalctl -u pihole-FTL -n 100 --no-pager",
  "journalctl -u nginx --since today | tail -50",
  "docker ps -a",
  "docker logs --tail 200 mailcow-postfix",
  "docker stats --no-stream",
  "pct list",
  "qm status 101",
  "zpool status",
  "ip -4 addr show",
  "ip route",
  "ping -c 3 192.168.10.1",
  "dig atlas.lan",
  "ls -la /var/log",
  "cat /etc/os-release",
  'grep -i "error" /var/log/syslog',
  "smartctl -H /dev/sda",
  "apt list --upgradable",
  "find /var/log -name '*.gz' -mtime +30",
];

const needsApproval = [
  "systemctl restart pihole-FTL",
  "systemctl --user stop nginx",
  "reboot",
  "rm -rf /tmp/x",
  "docker rm -f web",
  "docker stats",
  "pct stop 101",
  "qm destroy 101",
  "ip link set eth0 down",
  "ip route add default via 10.0.0.1",
  "find /var/log -name '*.gz' -delete",
  "find / -exec rm {} +",
  "journalctl --vacuum-size=100M",
  "smartctl -t long /dev/sda",
  "date -s 2020-01-01",
  "hostname newname",
  "apt upgrade -y",
  "uptime; reboot",
  "uptime && reboot",
  "uptime || reboot",
  "cat /etc/hosts > /tmp/x",
  "echo hi",
  "ls $(rm -rf /)",
  "ls `reboot`",
  "uptime &",
  "uptime\nreboot",
  "sudo -u root systemctl restart x",
  "/usr/bin/uptime",
  "FOO=1 uptime",
  "cat /etc/shadow",
  "sudo cat /root/.ssh/id_ed25519",
  "cat /opt/app/.env",
  'cat "/etc/sh"adow',
  "systemctl 'restart' nginx",
  "uptime | xargs reboot",
  "uptime | sh",
  "sed -i s/a/b/ /etc/hosts",
  "awk 'BEGIN{system(\"reboot\")}'",
  "",
];

describe("classifySshCommand", () => {
  it.each(readOnly)("lets %s run without approval", (command) => {
    expect(classifySshCommand(command)).toEqual({ readOnly: true });
  });

  it.each(needsApproval)("asks the owner before %j", (command) => {
    expect(classifySshCommand(command).readOnly).toBe(false);
  });
});
