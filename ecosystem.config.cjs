// PM2-стак форка codbash (badigit/codbash, ветка dim).
// Регистрируется в дашборде ai-tools через ~/.config/ai-tools-ui/pm2-stacks.json.
//
// Порт и host передаём флагами, а не через env: cli.js читает их из argv
// (--port=/--host=), переменные окружения он для этого не использует.
//
// host = localhost осознанно: дашборд отдаёт транскрипты ВСЕХ агентских сессий
// без авторизации. Наружу (10.9.0.x) открывать только сознательно — тогда
// --host=0.0.0.0 и firewall-правило.
const ROOT = 'C:/Users/Dee/GitHub/codbash'

module.exports = {
  apps: [
    {
      name: 'codbash',
      namespace: 'codbash',
      cwd: ROOT,
      script: 'bin/cli.js',
      args: 'run --no-browser --port=3847 --host=localhost',
      windowsHide: true,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      watch: false,
    },
  ],
}
