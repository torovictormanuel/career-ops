@echo off
REM career-ops WhatsApp Bot — Inicio automático
REM Ejecutar este archivo para arrancar el bot antes de usar n8n.
REM La primera vez mostrará un QR para vincular WhatsApp.

title Career-Ops WhatsApp Bot

cd /d "%~dp0"

echo ===================================
echo  career-ops WhatsApp Bot
echo ===================================
echo.

REM Verificar que .env existe
if not exist ".env" (
    echo [ERROR] Falta el archivo .env
    echo Copiá .env.example a .env y configurá WA_MY_NUMBER
    echo.
    pause
    exit /b 1
)

REM Verificar que node_modules existe
if not exist "node_modules\whatsapp-web.js" (
    echo [INFO] Instalando dependencias...
    call npm install
    if errorlevel 1 (
        echo [ERROR] npm install falló
        pause
        exit /b 1
    )
)

echo [OK] Iniciando bot... (Ctrl+C para detener)
echo.
echo Nota: La primera vez aparece un QR — escanearlo con WhatsApp
echo       (Dispositivos vinculados → Vincular un dispositivo)
echo.

:restart
node whatsapp-bot.mjs
echo.
echo [!] Bot detenido. Reiniciando en 10 segundos... (Ctrl+C para salir)
timeout /t 10 /nobreak >nul
goto restart
