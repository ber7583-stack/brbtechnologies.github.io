@echo off
echo.
echo ============================================
echo  EASY SETUP - Original Voicemail Voice
echo ============================================
echo.
echo This opens Chrome with simple instructions.
echo You sign in to Google yourself - we never see your password.
echo.
pause
python scripts\gv-session-login.py --easy
echo.
echo When you pasted into AWS Secrets Manager, leave a test voicemail.
echo.
pause
