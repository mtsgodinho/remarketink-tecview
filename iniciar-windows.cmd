@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
if not exist "package.json" (
  echo Extraia o ZIP inteiro antes de executar este arquivo.
  goto falha
)
where node >nul 2>nul
if errorlevel 1 (
  echo Instale o Node.js 24 em https://nodejs.org e abra este arquivo novamente.
  goto falha
)
node -e "if (Number(process.versions.node.split('.')[0]) !== 24) process.exit(1)"
if errorlevel 1 (
  echo Este projeto requer Node.js 24. Versao instalada:
  node --version
  echo Instale a versao 24 em https://nodejs.org e tente novamente.
  goto falha
)
if not exist "node_modules\next\package.json" (
  echo Instalando as dependencias do projeto...
  call npm ci
  if errorlevel 1 goto falha
)
call npm run local:setup
if errorlevel 1 goto falha
echo.
echo E-mail e senha locais: abra .data\local-access.txt nesta pasta.
echo Quando o servidor estiver pronto, acesse http://localhost:3000 no navegador.
echo Mantenha esta janela aberta. Para encerrar, pressione Ctrl+C.
echo.
call npm run dev -- --port 3000
if errorlevel 1 goto falha
exit /b 0
:falha
echo.
echo A inicializacao nao foi concluida. Confira a mensagem acima.
pause
exit /b 1
