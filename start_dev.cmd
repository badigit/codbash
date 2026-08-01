@echo off
rem Быстрый запуск через PM2 — единственный канон (agent-rules 71-pm2-fleet).
rem Второй экземпляр мимо PM2 не поднимаем: гонка за порт 3847.
cd /d "%~dp0"
set "FNMDEF=C:\Users\Dee\AppData\Roaming\fnm\aliases\default"
set "PM2=%FNMDEF%\pm2.cmd"
set "PATH=%FNMDEF%;%PATH%"
call "%PM2%" startOrRestart "%~dp0ecosystem.config.cjs"
call "%PM2%" ls
start "" "http://localhost:3847"
rem пауза, чтобы успеть прочитать статус (timeout требует stdin — берём ping)
ping -n 5 127.0.0.1 >nul
