//! 榫卯简历 · 桌面外壳（ResumeFLOW 本地版）
//!
//! - 单实例：再次启动只把已有窗口唤到前台。
//! - 不常驻后台：窗口关掉程序就退出。
//! - 可以单独运行；如果装了「万象之匣」，会读取它的全局设置（AI 接口等），
//!   读取的是 `%APPDATA%\lab.banshou.hako\settings.json` 这个普通 JSON 文件，
//!   两个程序之间只通过这个文件交换配置，不共用代码。

use std::path::PathBuf;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const MAIN_WINDOW: &str = "main";

/// 万象之匣全局设置文件的位置。
fn bansho_settings_path() -> Option<PathBuf> {
    let appdata = std::env::var_os("APPDATA")
        .or_else(|| std::env::var_os("XDG_CONFIG_HOME"))
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
    Some(appdata.join("lab.banshou.hako").join("settings.json"))
}

/// 读取万象之匣的全局设置；没装万象之匣或还没保存过设置时返回 None。
#[tauri::command]
fn read_bansho_settings() -> Option<String> {
    let path = bansho_settings_path()?;
    let text = std::fs::read_to_string(path).ok()?;
    // 只接受合法 JSON，坏文件当作不存在。
    serde_json::from_str::<serde_json::Value>(&text).ok()?;
    Some(text)
}

/// 告诉网页这是桌面版。
#[tauri::command]
fn desktop_info(app: AppHandle) -> serde_json::Value {
    serde_json::json!({
        "desktop": true,
        "version": app.package_info().version.to_string(),
        "banshoSettingsPath": bansho_settings_path().map(|p| p.to_string_lossy().to_string()),
    })
}

fn show_main(app: &AppHandle) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App("index.html".into()))
        .title("榫卯简历")
        .inner_size(1360.0, 880.0)
        .min_inner_size(900.0, 600.0)
        .center()
        .focused(true)
        // 让网页自己处理拖入的简历文件
        .disable_drag_drop_handler()
        .build()?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 必须第一个注册：第二次启动时唤醒已有窗口，自己退出。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            let _ = show_main(app);
        }))
        // 模型请求从 Rust 发出，不受浏览器跨域限制。
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![read_bansho_settings, desktop_info])
        .setup(|app| {
            show_main(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("榫卯简历启动失败");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_path_points_to_bansho_config_dir() {
        std::env::set_var("APPDATA", "C:\\Users\\me\\AppData\\Roaming");
        let p = bansho_settings_path().unwrap();
        let s = p.to_string_lossy();
        assert!(s.contains("lab.banshou.hako"));
        assert!(s.ends_with("settings.json"));
    }
}
