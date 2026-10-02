"""Explicit interactive login, separate from connection and message delivery."""
import os
import time


def login_via_browser() -> tuple[str, str]:
    """브라우저로 네이버 로그인 → 쿠키 자동 캡처"""
    try:
        import undetected_chromedriver as uc
    except ImportError:
        print("undetected-chromedriver가 필요합니다: pip install undetected-chromedriver")
        return "", ""

    print("\n네이버 로그인 창을 여는 중...")
    print("로그인 완료 후 자동으로 쿠키를 가져옵니다.\n")

    # Chrome 버전 자동 감지 (PowerShell로 exe 파일 버전 읽기)
    chrome_path = uc.find_chrome_executable()
    ver = None
    import subprocess
    try:
        out = subprocess.check_output(
            ["powershell", "-Command",
             "(Get-Item -LiteralPath '" + str(chrome_path).replace("'", "''") + "').VersionInfo.FileVersion"],
            text=True,
            timeout=10,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        ver = int(out.strip().split(".")[0])
        print(f"Chrome {ver} 감지됨")
    except Exception:
        pass

    import tempfile
    tmp_profile = os.path.join(tempfile.gettempdir(), "chzzk_bot_chrome")
    os.makedirs(tmp_profile, exist_ok=True)
    driver = uc.Chrome(
        headless=False,
        version_main=ver,
        user_data_dir=tmp_profile,
    )
    nid_aut = ""
    nid_ses = ""

    try:
        # 1단계: 네이버 로그인 페이지로 이동
        driver.get("https://nid.naver.com/nidlogin.login?url=https://chzzk.naver.com/")
        time.sleep(2)

        # 2단계: 로그인 완료 대기 (로그인 페이지를 벗어날 때까지)
        from selenium.webdriver.support.ui import WebDriverWait
        if "nidlogin" in driver.current_url:
            print("네이버 로그인을 완료해주세요 (최대 3분 대기)...")
            WebDriverWait(driver, 180).until(
                lambda d: "nidlogin" not in d.current_url
            )

        # 3단계: chzzk.naver.com으로 이동해서 쿠키 추출
        driver.get("https://chzzk.naver.com/")
        time.sleep(2)

        cookies = driver.get_cookies()
        for c in cookies:
            if c["name"] == "NID_AUT":
                nid_aut = c["value"]
            elif c["name"] == "NID_SES":
                nid_ses = c["value"]

        if nid_aut and nid_ses:
            print("로그인 성공! 쿠키를 가져왔습니다.")
    except Exception as e:
        print(f"로그인 실패 ({type(e).__name__}). 다시 로그인해주세요.")
    finally:
        try:
            driver.quit()
        except Exception:
            pass

    return nid_aut, nid_ses
