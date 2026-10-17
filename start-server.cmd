@echo off
rem Double-click this file to start the Barbershop Queue System.
rem Keep this window open while using the site; close it to stop the server.
cd /d "%~dp0"
title Barbershop Queue Server
echo Starting the Barbershop Queue System...
echo Open http://localhost:3000 in your browser. 2FA login codes appear below.
echo.
call npm start
echo.
echo The server has stopped.
pause
