#include <stdio.h>
#include <string.h>
#include <strings.h>
#include <stdbool.h>
#include <stdint.h>
#include <ctype.h>
#include <errno.h>
#include <math.h>
#include <unistd.h>
#include <fcntl.h>

#include <lwip/sockets.h>
#include <lwip/inet.h>

#include "sdkconfig.h"

#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/semphr.h>
#include <freertos/task.h>

#include <esp_err.h>
#include <esp_attr.h>
#include <esp_event.h>
#include <esp_http_client.h>
#include <esp_log.h>
#include <esp_netif.h>
#include <esp_sleep.h>
#include <lwip/ip4_addr.h>
#include <esp_timer.h>
#include <esp_wifi.h>
#include <nvs_flash.h>

#include <driver/gpio.h>

#if defined(CONFIG_PM_ENABLE)
#include <esp_pm.h>
#endif

#include <cJSON.h>
#include <lvgl/lvgl.h>

#include "core2forAWS.h"
#include "axp192_i2c.h"

/*
192.168.26.109	quality press 14
192.168.26.110	supervisor press 15
192.168.26.111	Quality press 15

 * DEBUG CONFIGURATION
 * Keep direct values for now so sdkconfig cannot silently override them.
 * 
 * Quality Press 14 pager token = "pg_DTqgAjDJ9GPyAQviYYV9Ok9n2rmfrL1R"
 * Supervisor press 15 pager token = "pg_2Dr5Sqixt5ON8P1JY7z3cXHzCMl-VNbo"
 * Quality Press 15 pager token = "pg_EOV7dN1td-FZI8QvdgWG81QU31w4Dq22"



 */
static const char *WIFI_SSID = "DEV-APPS";
static const char *WIFI_PASSWORD = "2FSM#DEV@APP1";
static const char *API_BASE_URL = "http://192.168.26.2:5003";

/* 
 * Set to 0 to use DHCP instead. */
#define USE_STATIC_IP 1
static const char *STATIC_IP_ADDR = "192.168.26.109";
static const char *STATIC_IP_GATEWAY = "192.168.26.2";
static const char *STATIC_IP_NETMASK = "255.255.255.0";


static const char *PAGER_TOKEN ="pg_DTqgAjDJ9GPyAQviYYV9Ok9n2rmfrL1R";
static const char *PAGER_RESPONDER_NAME = "Quality Press 14";
/*Local device-side machine scope. Empty string means all machines. */
static const char *PAGER_MACHINE_FILTER = "Press 14";



#define MAX_ALERTS 16
#define MAX_TEXT 96
#define MAX_STATUS 32
#define MAX_ID 64
#define HTTP_BUFFER_SIZE 4096

#define VISIBLE_CARDS 4
#define UI_ACTIVE_TICK_MS 250

/* With the backlight off nothing on screen needs redrawing, so the pager task
 * can sleep far longer between wakeups. A touch or button press gives
 * g_wake_sem, which cuts this wait short, so responsiveness is unchanged. */
#define UI_SCREEN_OFF_TICK_MS 1000

#define TOUCH_WAKE_TASK_TICK_MS 50

/*
 * Battery / charge sampling.
 *
 * These used to be serviced inside pager_task, which is also the task that
 * blocks inside esp_http_client_perform() and services Wi-Fi reconnects. The
 * AXP192 lives on local I2C and has nothing to do with the network, so it now
 * has its own task (power_monitor_task) and cannot be starved by HTTP, a
 * reconnect storm, or a disconnected AP.
 *
 * The cadence is also much faster while the screen is on: at the old 30 s
 * interval combined with the low-pass filter below, a real percentage change
 * took several minutes to reach the label, which looked exactly like a frozen
 * reading.
 */
#define BATTERY_REFRESH_ACTIVE_MS 5000
#define BATTERY_REFRESH_SCREEN_OFF_MS 30000

/* A single failed I2C read used to abort the whole refresh silently. */
#define BATTERY_SAMPLE_RETRIES 3

/* Usable inner width of the battery body glyph (28 px wide, 2 px border). */
#define BATTERY_FILL_MAX_W 22

#define POLL_WITH_UNACKED_OPEN_MS 45000
#define POLL_IDLE_MS 45000
#define POLL_ERROR_MS 15000

#define DISPLAY_ACTIVE_BRIGHTNESS 100
#define DISPLAY_DIM_BRIGHTNESS 10

#define DISPLAY_OFF_NO_ALERT_MS 3000
#define DISPLAY_DIM_WITH_ALERT_MS 5000
#define DISPLAY_OFF_WITH_ALERT_MS 15000

#define NEW_OPEN_VIBRATE_COOLDOWN_MS 2000
#define OPEN_REPEAT_VIBRATE_MS 0
#define NEW_ALERT_VIBRATE_MS 2500
#define ACK_SYNC_GRACE_MS 30000
#define ACK_INSTRUCTION_MS 3000

#define ENABLE_DEEP_SLEEP_WHEN_NO_OPEN 0
#define DEEP_SLEEP_NO_OPEN_AFTER_MS 120000
#define DEEP_SLEEP_WAKE_US (60ULL * 1000ULL * 1000ULL)
#define TOUCH_WAKE_GPIO GPIO_NUM_39

/*
 * Wi-Fi radio power save. This is the single largest battery item on a
 * REST-polling pager: with WIFI_PS_NONE the radio receiver stays powered
 * continuously between the 45 s polls even though nothing is inbound.
 *
 * WIFI_PS_MIN_MODEM parks the radio between AP beacons and is safe here
 * because every transaction is initiated by the pager. WIFI_PS_MAX_MODEM
 * saves more but skips beacons (WIFI_LISTEN_INTERVAL of them), which some
 * plant APs handle poorly; switch to it only after testing on the real AP.
 */
#define WIFI_POWER_SAVE_MODE WIFI_PS_MIN_MODEM
#define WIFI_LISTEN_INTERVAL 3

/*
 * Boot-time TCP reachability probe. Useful while bringing up a new plant
 * network, expensive afterwards: on an isolated VLAN the two external
 * targets each block for the full 10 s timeout with the radio at full power.
 * Set to 1 to re-enable it for debugging.
 */
#define ENABLE_TCP_DIAGNOSTIC_PROBE 0

/* This pager does not use the M-BUS/expansion 5 V rail. Keeping the AXP192
 * boost output disabled avoids powering an unused rail. Set to 0 if an
 * attached accessory actually needs 5 V from the Core2. */
#define DISABLE_UNUSED_5V_EXPANSION 1

#define RESOLVED_SUPPRESS_MS 12000

/* Reconnect backoff. Prevents constant disconnect/reconnect hammering. */
#define WIFI_RECONNECT_MIN_MS 5000
#define WIFI_RECONNECT_MAX_MS 10000

typedef struct {
    char id[MAX_ID];
    char machine[MAX_TEXT];
    char machine_name[MAX_TEXT];
    char machine_code[MAX_TEXT];
    char issue[MAX_TEXT];
    char message[MAX_TEXT];
    char status[MAX_STATUS];
    char status_label[MAX_STATUS];
    char action_available[MAX_STATUS];
    char responder_name[MAX_TEXT];
    int elapsed_seconds;
    bool actionable;
} andon_alert_t;

static const char *TAG = "andon_pager";

static andon_alert_t g_alerts[MAX_ALERTS];
static andon_alert_t g_parse_alerts[MAX_ALERTS];
static andon_alert_t g_filtered_alerts[MAX_ALERTS];
static size_t g_alert_count = 0;
static uint32_t g_alert_hash = 0;
static int64_t g_last_sync_ms = 0;

static char g_recently_resolved_id[MAX_ID] = "";
static int64_t g_recently_resolved_until_ms = 0;

/* Prevent a just-acknowledged alert from being treated as new again while
 * the backend is still converging from OPEN -> ACKNOWLEDGED. */
static char g_recently_acknowledged_id[MAX_ID] = "";
static int64_t g_recently_acknowledged_until_ms = 0;

/* Non-blocking motor deadline. This keeps ACK/network/UI processing alive
 * during a long vibration. */
static int64_t g_vibration_until_ms = 0;

static char g_prev_open_ids[MAX_ALERTS][MAX_ID];
static size_t g_prev_open_count = 0;
static int64_t g_last_new_vibrate_ms = 0;
static int64_t g_last_repeat_vibrate_ms = 0;

static volatile bool g_wifi_connected = false;
static bool g_last_transport_error = false;
static int g_last_http_status = -1;
static char g_last_http_reason[32] = "idle";
static int64_t g_next_wifi_reconnect_ms = 0;
static int g_wifi_reconnect_delay_ms = WIFI_RECONNECT_MIN_MS;

static esp_http_client_handle_t g_get_client = NULL;
static esp_http_client_handle_t g_post_client = NULL;
static char g_http_response[HTTP_BUFFER_SIZE];
static int g_http_response_len = 0;
static bool g_http_response_truncated = false;

static lv_obj_t *g_title_label = NULL;
static lv_obj_t *g_status_label = NULL;
static lv_obj_t *g_list_area = NULL;
static lv_obj_t *g_empty_label = NULL;

static lv_obj_t *g_card_btn[VISIBLE_CARDS];
static lv_obj_t *g_card_label[VISIBLE_CARDS];
static int g_card_alert_index[VISIBLE_CARDS];

static lv_obj_t *g_action_btn = NULL;
static lv_obj_t *g_action_label = NULL;
static lv_obj_t *g_back_btn = NULL;
static lv_obj_t *g_back_label = NULL;

static lv_obj_t *g_prev_btn = NULL;
static lv_obj_t *g_prev_label = NULL;
static lv_obj_t *g_next_btn = NULL;
static lv_obj_t *g_next_label = NULL;
static lv_obj_t *g_page_label = NULL;

static lv_obj_t *g_busy_overlay = NULL;
static lv_obj_t *g_busy_label = NULL;
static lv_obj_t *g_instruction_banner = NULL;
static lv_obj_t *g_instruction_label = NULL;

static lv_obj_t *g_battery_body = NULL;
static lv_obj_t *g_battery_tip = NULL;
static lv_obj_t *g_battery_fill = NULL;
static lv_obj_t *g_battery_label = NULL;
static lv_obj_t *g_charging_icon = NULL;
static int g_battery_percent = -1;
static bool g_charge_status_valid = false;
static bool g_battery_is_charging = false;

/* External supply (ACIN or VBUS) present, independent of whether the charger
 * is currently pushing current into the cell. A full pack on the charger
 * reports "not charging" on REG00 bit 2, which previously looked identical to
 * running on battery. */
static bool g_external_power = false;

/* Set whenever something should override the "percentage did not change"
 * early return: display wake, charge-state transition, first sample. */
static volatile bool g_force_battery_refresh = true;

/* Discard the low-pass history instead of crawling toward a new operating
 * point (plugging in / unplugging shifts terminal voltage immediately). */
static volatile bool g_battery_snap_filter = true;

static char g_selected_alert_id[MAX_ID] = "";
static bool g_detail_mode = false;
static size_t g_page_offset = 0;
static volatile bool g_ui_dirty = true;
static volatile bool g_action_in_flight = false;

static QueueHandle_t g_action_queue = NULL;
static SemaphoreHandle_t g_display_power_mutex = NULL;

/* Given by the touch task and the button handlers to cut short the pager
 * task's idle wait. Lets the idle wait be long (battery) without making the
 * UI feel slow (responsiveness). */
static SemaphoreHandle_t g_wake_sem = NULL;

/* Same idea for the power monitor task: a touch wake should re-read the
 * AXP192 immediately rather than showing a value up to 30 s old. */
static SemaphoreHandle_t g_battery_wake_sem = NULL;

static int64_t g_last_user_activity_ms = 0;
static int64_t g_no_open_since_ms = 0;
static volatile uint8_t g_display_brightness = 255;
static int64_t g_instruction_until_ms = 0;
static bool g_timer_wakeup_boot = false;
static bool g_initial_sync_complete = false;

/* Survives deep sleep. Supplying the last channel as a scan hint makes the
 * once-per-minute association much shorter without locking to one BSSID. */
RTC_DATA_ATTR static uint8_t g_saved_wifi_channel = 0;

static void render_alerts(void);
static void update_battery_indicator(void);
static void pager_event_handler(lv_obj_t *obj, lv_event_t event);
static void action_button_event_handler(lv_obj_t *obj, lv_event_t event);
static void back_button_event_handler(lv_obj_t *obj, lv_event_t event);
static void page_prev_event_handler(lv_obj_t *obj, lv_event_t event);
static void page_next_event_handler(lv_obj_t *obj, lv_event_t event);
static bool is_recently_acknowledged_suppressed(const char *alert_id);

static int64_t now_ms(void)
{
    return esp_timer_get_time() / 1000;
}

static void notify_pager_wake(void)
{
    if (g_wake_sem) {
        xSemaphoreGive(g_wake_sem);
    }
}

/* Cut short the power monitor task's wait and make the next sample render
 * even if the integer percentage is unchanged. */
static void notify_battery_refresh(void)
{
    g_force_battery_refresh = true;

    if (g_battery_wake_sem) {
        xSemaphoreGive(g_battery_wake_sem);
    }
}

static void pager_wait_ms(int wait_ms)
{
    if (wait_ms <= 0) {
        return;
    }

    if (g_wake_sem) {
        /* Returns early if something gave the semaphore; otherwise this is a
         * plain blocking wait and the CPU can enter light sleep. */
        xSemaphoreTake(g_wake_sem, pdMS_TO_TICKS(wait_ms));
    } else {
        vTaskDelay(pdMS_TO_TICKS(wait_ms));
    }
}

static void set_display_brightness(uint8_t brightness)
{
    xSemaphoreTake(g_display_power_mutex, portMAX_DELAY);

    if (g_display_brightness == brightness) {
        xSemaphoreGive(g_display_power_mutex);
        return;
    }

    if (brightness == 0) {
        /* The BSP maps brightness 0 to a still-enabled 2.2 V DCDC3 rail.
         * Turn that backlight rail off after preserving the requested value. */
        Core2ForAWS_Display_SetBrightness(0);
        Axp192_EnableDCDC3(0);
    } else {
        /* Program the requested voltage before enabling the rail so wake-up
         * does not briefly restart at the old minimum voltage. */
        Core2ForAWS_Display_SetBrightness(brightness);
        Axp192_EnableDCDC3(1);
    }

    g_display_brightness = brightness;
    xSemaphoreGive(g_display_power_mutex);
}

static void mark_user_activity_now(void)
{
    xSemaphoreTake(g_display_power_mutex, portMAX_DELAY);
    g_last_user_activity_ms = now_ms();
    xSemaphoreGive(g_display_power_mutex);
}

static int64_t read_last_user_activity_ms(void)
{
    xSemaphoreTake(g_display_power_mutex, portMAX_DELAY);
    int64_t activity_ms = g_last_user_activity_ms;
    xSemaphoreGive(g_display_power_mutex);
    return activity_ms;
}

static void record_user_activity(void)
{
    /* Once a person is interacting, this is no longer a maintenance-only
     * wake and the normal no-OPEN grace period must apply. */
    g_timer_wakeup_boot = false;
    mark_user_activity_now();
    set_display_brightness(DISPLAY_ACTIVE_BRIGHTNESS);

    /* Interrupt the pager task's idle wait so the screen repaints at once. */
    notify_pager_wake();

    /* Whoever just woke the screen is looking at the battery indicator right
     * now, so re-read the AXP192 instead of showing a value up to one sleep
     * interval old. */
    notify_battery_refresh();
}

static void wake_display_for_event(void)
{
    mark_user_activity_now();
    set_display_brightness(DISPLAY_ACTIVE_BRIGHTNESS);
    notify_battery_refresh();
}

/*
 * Li-ion discharge is strongly non-linear, so the previous straight line from
 * 3.20 V to 4.20 V misreported most of the usable range - in particular it
 * pushed mid-charge cells down into the <=20% red band. This is a piecewise
 * curve for a single-cell LiPo under the Core2's light load.
 *
 * While the AXP192 is charging, terminal voltage sits above the cell's rested
 * voltage. Removing a fixed offset stops the reading from jumping the moment
 * USB is plugged in or pulled.
 */
static int battery_percent_from_voltage(float voltage, bool charging)
{
    static const float curve_v[] =
        { 3.30f, 3.50f, 3.60f, 3.70f, 3.75f, 3.80f, 3.90f, 4.00f, 4.10f, 4.20f };
    static const int curve_pct[] =
        { 0,     10,    20,    35,    45,    55,    70,    82,    92,    100  };

    const size_t point_count = sizeof(curve_pct) / sizeof(curve_pct[0]);

    if (charging) {
        voltage -= 0.06f;
    }

    if (voltage <= curve_v[0]) {
        return 0;
    }
    if (voltage >= curve_v[point_count - 1]) {
        return 100;
    }

    for (size_t i = 1; i < point_count; i++) {
        if (voltage <= curve_v[i]) {
            float span = curve_v[i] - curve_v[i - 1];
            float frac = (voltage - curve_v[i - 1]) / span;
            int delta = curve_pct[i] - curve_pct[i - 1];
            return curve_pct[i - 1] + (int)((frac * (float)delta) + 0.5f);
        }
    }

    return 100;
}

static lv_color_t battery_color_for_percent(int pct)
{
    if (pct <= 20) {
        return LV_COLOR_MAKE(0xE5, 0x39, 0x35);
    }
    if (pct <= 45) {
        return LV_COLOR_MAKE(0xFB, 0x8C, 0x00);
    }
    return LV_COLOR_MAKE(0x43, 0xA0, 0x47);
}

static lv_color_t color_for_alert_status(const char *status)
{
    if (strcasecmp(status, "OPEN") == 0) {
        return LV_COLOR_MAKE(0xFF, 0xEB, 0xEE);
    }
    if (strcasecmp(status, "ACKNOWLEDGED") == 0 || strcasecmp(status, "ARRIVED") == 0) {
        return LV_COLOR_MAKE(0xFF, 0xF8, 0xE1);
    }
    return LV_COLOR_MAKE(0xF5, 0xF7, 0xFA);
}

static lv_color_t border_color_for_alert_status(const char *status)
{
    if (strcasecmp(status, "OPEN") == 0) {
        return LV_COLOR_MAKE(0xD3, 0x2F, 0x2F);
    }
    if (strcasecmp(status, "ACKNOWLEDGED") == 0 || strcasecmp(status, "ARRIVED") == 0) {
        return LV_COLOR_MAKE(0xFB, 0x8C, 0x00);
    }
    return LV_COLOR_MAKE(0x90, 0xA4, 0xAE);
}

static void elapsed_to_text(int elapsed_seconds, char *out, size_t out_len)
{
    if (elapsed_seconds < 0) {
        elapsed_seconds = 0;
    }

    int minutes = elapsed_seconds / 60;
    int hours = minutes / 60;
    minutes %= 60;

    if (hours > 0) {
        snprintf(out, out_len, "%dh %02dm", hours, minutes);
    } else {
        snprintf(out, out_len, "%dm", minutes);
    }
}

static int clamp_elapsed(int elapsed_seconds)
{
    if (elapsed_seconds < 0) {
        return 0;
    }
    if (elapsed_seconds > 24 * 60 * 60) {
        return 24 * 60 * 60;
    }
    return elapsed_seconds;
}

/*
 * Normalize machine identifiers so "Press 14" also matches values such as
 * "PRESS-14", "Press_14", or "Press #14" from the backend.
 */
static void normalize_machine_key(const char *input, char *out, size_t out_len)
{
    if (!out || out_len == 0) {
        return;
    }

    out[0] = '\0';
    if (!input) {
        return;
    }

    size_t j = 0;
    for (size_t i = 0; input[i] != '\0' && j + 1 < out_len; i++) {
        unsigned char ch = (unsigned char)input[i];
        if (isalnum(ch)) {
            out[j++] = (char)tolower(ch);
        }
    }
    out[j] = '\0';
}

static bool alert_matches_machine_filter(const andon_alert_t *alert)
{
    if (!alert) {
        return false;
    }

    /* Empty filter means every machine already authorized by the pager token. */
    if (!PAGER_MACHINE_FILTER || PAGER_MACHINE_FILTER[0] == '\0') {
        return true;
    }

    char wanted[MAX_TEXT];
    char machine_name[MAX_TEXT];
    char machine_code[MAX_TEXT];

    normalize_machine_key(PAGER_MACHINE_FILTER, wanted, sizeof(wanted));
    normalize_machine_key(alert->machine_name, machine_name, sizeof(machine_name));
    normalize_machine_key(alert->machine_code, machine_code, sizeof(machine_code));

    if (wanted[0] == '\0') {
        return true;
    }

    return (machine_name[0] != '\0' && strcmp(wanted, machine_name) == 0) ||
           (machine_code[0] != '\0' && strcmp(wanted, machine_code) == 0);
}

static void set_status_text(const char *text, lv_color_t color)
{
    static char last_text[64] = "";

    if (!text || !g_status_label) {
        return;
    }

    if (strcmp(last_text, text) == 0) {
        return;
    }

    ESP_LOGI(TAG, "UI status: %s", text);

    if (pdTRUE == xSemaphoreTake(xGuiSemaphore, portMAX_DELAY)) {
        lv_label_set_text(g_status_label, text);
        lv_obj_set_style_local_text_color(g_status_label, LV_LABEL_PART_MAIN, LV_STATE_DEFAULT, color);
        xSemaphoreGive(xGuiSemaphore);
    }

    snprintf(last_text, sizeof(last_text), "%s", text);
}

static void show_instruction_banner(const char *text)
{
    if (!text || !g_instruction_label || !g_instruction_banner) {
        return;
    }

    g_instruction_until_ms = now_ms() + ACK_INSTRUCTION_MS;
    wake_display_for_event();

    if (pdTRUE == xSemaphoreTake(xGuiSemaphore, portMAX_DELAY)) {
        lv_label_set_text(g_instruction_label, text);
        lv_obj_set_hidden(g_instruction_banner, false);
        lv_obj_move_foreground(g_instruction_banner);
        xSemaphoreGive(xGuiSemaphore);
    }

    g_ui_dirty = true;
}

static int find_alert_index_by_id(const char *alert_id)
{
    if (!alert_id || alert_id[0] == '\0') {
        return -1;
    }

    for (size_t i = 0; i < g_alert_count; i++) {
        if (strcmp(g_alerts[i].id, alert_id) == 0) {
            return (int)i;
        }
    }

    return -1;
}

static bool id_in_list(char ids[MAX_ALERTS][MAX_ID], size_t count, const char *id)
{
    if (!id) {
        return false;
    }

    for (size_t i = 0; i < count; i++) {
        if (strcmp(ids[i], id) == 0) {
            return true;
        }
    }

    return false;
}

static bool alert_needs_web_clear_instruction(const andon_alert_t *alert)
{
    if (!alert) {
        return false;
    }

    return strcasecmp(alert->status, "ACKNOWLEDGED") == 0 ||
           strcasecmp(alert->status, "ARRIVED") == 0;
}

static bool alert_is_unacknowledged_open(const andon_alert_t *alert)
{
    if (!alert) {
        return false;
    }

    return strcasecmp(alert->status, "OPEN") == 0;
}

static size_t count_unacknowledged_open_alerts(void)
{
    size_t open_count = 0;

    for (size_t i = 0; i < g_alert_count; i++) {
        if (alert_is_unacknowledged_open(&g_alerts[i])) {
            open_count++;
        }
    }

    return open_count;
}

static void set_led_idle(void)
{
#if CONFIG_SOFTWARE_SK6812_SUPPORT
    Core2ForAWS_Sk6812_Clear();
    Core2ForAWS_Sk6812_Show();
#endif
    Core2ForAWS_LED_Enable(0);
}

static void vibrate_pattern_new_alert(void)
{
    ESP_LOGI(TAG, "Vibration pattern: strong %d ms new alert", NEW_ALERT_VIBRATE_MS);

    /* Start the motor and return immediately. Do NOT vTaskDelay() here: this
     * runs in the pager task, and blocking it would delay ACK processing. */
    Core2ForAWS_Motor_SetStrength(100);
    g_vibration_until_ms = now_ms() + NEW_ALERT_VIBRATE_MS;
}

static void process_vibration_state(void)
{
    if (g_vibration_until_ms > 0 && now_ms() >= g_vibration_until_ms) {
        Core2ForAWS_Motor_SetStrength(0);
        g_vibration_until_ms = 0;
    }
}

static void stop_alert_vibration(void)
{
    Core2ForAWS_Motor_SetStrength(0);
    g_vibration_until_ms = 0;
    g_last_repeat_vibrate_ms = now_ms();
}

static void apply_alert_signal_state(void)
{
    char current_open_ids[MAX_ALERTS][MAX_ID];
    size_t current_open_count = 0;

    for (size_t i = 0; i < g_alert_count && i < MAX_ALERTS; i++) {
        if (alert_is_unacknowledged_open(&g_alerts[i]) &&
            !is_recently_acknowledged_suppressed(g_alerts[i].id)) {
            snprintf(current_open_ids[current_open_count], MAX_ID, "%s", g_alerts[i].id);
            current_open_count++;
        }
    }

    bool has_new_open = false;
    for (size_t i = 0; i < current_open_count; i++) {
        if (!id_in_list(g_prev_open_ids, g_prev_open_count, current_open_ids[i])) {
            has_new_open = true;
            break;
        }
    }

    int64_t now = now_ms();

    if (has_new_open &&
        now - g_last_new_vibrate_ms >= NEW_OPEN_VIBRATE_COOLDOWN_MS) {
        ESP_LOGI(TAG, "New unacknowledged OPEN alert detected");
        wake_display_for_event();
        vibrate_pattern_new_alert();
        g_last_new_vibrate_ms = now;
        g_last_repeat_vibrate_ms = now;
    }

    if (current_open_count == 0) {
        stop_alert_vibration();
    }

    g_prev_open_count = current_open_count;
    for (size_t i = 0; i < current_open_count; i++) {
        snprintf(g_prev_open_ids[i], MAX_ID, "%s", current_open_ids[i]);
    }

    set_led_idle();
}

static void process_open_reminder_vibration(void)
{
#if OPEN_REPEAT_VIBRATE_MS > 0
    size_t open_count = count_unacknowledged_open_alerts();

    int64_t now = now_ms();

    if (open_count == 0) {
        stop_alert_vibration();
        return;
    }

    if (now - g_last_repeat_vibrate_ms < OPEN_REPEAT_VIBRATE_MS) {
        return;
    }

    ESP_LOGI(TAG, "Unacknowledged OPEN reminder vibration, open_count=%u", (unsigned int)open_count);
    vibrate_pattern_new_alert();
    g_last_repeat_vibrate_ms = now;
#endif
}

static bool is_recently_acknowledged_suppressed(const char *alert_id)
{
    if (!alert_id || alert_id[0] == '\0' || g_recently_acknowledged_id[0] == '\0') {
        return false;
    }

    int64_t now = now_ms();
    if (now > g_recently_acknowledged_until_ms) {
        g_recently_acknowledged_id[0] = '\0';
        g_recently_acknowledged_until_ms = 0;
        return false;
    }

    return strcmp(alert_id, g_recently_acknowledged_id) == 0;
}

static void clear_recent_ack_if_matches(const char *alert_id)
{
    if (alert_id && strcmp(alert_id, g_recently_acknowledged_id) == 0) {
        g_recently_acknowledged_id[0] = '\0';
        g_recently_acknowledged_until_ms = 0;
    }
}

static bool is_recently_resolved_suppressed(const char *alert_id)
{
    if (!alert_id || alert_id[0] == '\0' || g_recently_resolved_id[0] == '\0') {
        return false;
    }

    int64_t now = now_ms();

    if (now > g_recently_resolved_until_ms) {
        g_recently_resolved_id[0] = '\0';
        g_recently_resolved_until_ms = 0;
        return false;
    }

    return strcmp(alert_id, g_recently_resolved_id) == 0;
}

static uint32_t fnv1a_update(uint32_t h, const char *s)
{
    if (!s) {
        return h;
    }

    while (*s) {
        h ^= (uint8_t)(*s++);
        h *= 16777619u;
    }

    return h;
}

static uint32_t alert_state_hash(const andon_alert_t *alerts, size_t count)
{
    uint32_t h = 2166136261u;

    for (size_t i = 0; i < count; i++) {
        h = fnv1a_update(h, alerts[i].id);
        h = fnv1a_update(h, alerts[i].machine);
        h = fnv1a_update(h, alerts[i].issue);
        h = fnv1a_update(h, alerts[i].message);
        h = fnv1a_update(h, alerts[i].status);
        h = fnv1a_update(h, alerts[i].status_label);
        h = fnv1a_update(h, alerts[i].action_available);
        h = fnv1a_update(h, alerts[i].responder_name);
    }

    return h;
}

static bool extract_json_payload(const char *raw, char *out, size_t out_len)
{
    if (!raw || !out || out_len < 4) {
        return false;
    }

    const char *start = raw;
    while (*start && *start != '{' && *start != '[') {
        start++;
    }

    if (*start == '\0') {
        return false;
    }

    const char *end_obj = strrchr(start, '}');
    const char *end_arr = strrchr(start, ']');
    const char *end = end_obj;

    if (end_arr && (!end || end_arr > end)) {
        end = end_arr;
    }

    if (!end || end < start) {
        return false;
    }

    size_t len = (size_t)(end - start + 1);
    if (len >= out_len) {
        len = out_len - 1;
    }

    memcpy(out, start, len);
    out[len] = '\0';
    return true;
}

static void get_string_fallback(cJSON *obj,
                                const char **keys,
                                size_t key_count,
                                char *out,
                                size_t out_size,
                                const char *default_value)
{
    for (size_t i = 0; i < key_count; i++) {
        cJSON *item = cJSON_GetObjectItemCaseSensitive(obj, keys[i]);
        if (cJSON_IsString(item) && item->valuestring && item->valuestring[0] != '\0') {
            snprintf(out, out_size, "%s", item->valuestring);
            return;
        }
    }

    snprintf(out, out_size, "%s", default_value);
}

static void get_nested_string(cJSON *obj,
                              const char *parent_key,
                              const char *child_key,
                              char *out,
                              size_t out_size,
                              const char *default_value)
{
    cJSON *parent = cJSON_GetObjectItemCaseSensitive(obj, parent_key);

    if (cJSON_IsObject(parent)) {
        cJSON *child = cJSON_GetObjectItemCaseSensitive(parent, child_key);
        if (cJSON_IsString(child) && child->valuestring && child->valuestring[0] != '\0') {
            snprintf(out, out_size, "%s", child->valuestring);
            return;
        }
    }

    snprintf(out, out_size, "%s", default_value);
}

static int infer_elapsed_from_json(cJSON *obj)
{
    const char *keys[] = {
        "elapsed_seconds",
        "elapsed",
        "duration_seconds",
        "age_seconds"
    };

    for (size_t i = 0; i < sizeof(keys) / sizeof(keys[0]); i++) {
        cJSON *item = cJSON_GetObjectItemCaseSensitive(obj, keys[i]);
        if (cJSON_IsNumber(item)) {
            return (int)item->valuedouble;
        }
    }

    return 0;
}

static bool parse_alert_item(cJSON *item, andon_alert_t *alert)
{
    if (!cJSON_IsObject(item) || !alert) {
        return false;
    }

    memset(alert, 0, sizeof(*alert));

    cJSON *id_item = cJSON_GetObjectItemCaseSensitive(item, "id");
    if (cJSON_IsNumber(id_item)) {
        snprintf(alert->id, sizeof(alert->id), "%d", id_item->valueint);
    } else {
        const char *id_keys[] = { "id" };
        get_string_fallback(item, id_keys, 1, alert->id, sizeof(alert->id), "");
    }

    if (alert->id[0] == '\0') {
        return false;
    }

    char machine_name[MAX_TEXT];
    char machine_code[MAX_TEXT];
    char issue_category[MAX_TEXT];
    char issue_problem[MAX_TEXT];

    get_nested_string(item, "machine", "name", machine_name, sizeof(machine_name), "Unknown machine");
    get_nested_string(item, "machine", "machine_code", machine_code, sizeof(machine_code), "");
    get_nested_string(item, "issue_category", "name", issue_category, sizeof(issue_category), "Unknown category");
    get_nested_string(item, "issue_problem", "name", issue_problem, sizeof(issue_problem), "Unknown problem");

    snprintf(alert->machine_name, sizeof(alert->machine_name), "%s", machine_name);
    snprintf(alert->machine_code, sizeof(alert->machine_code), "%s", machine_code);

    if (machine_code[0] != '\0') {
        snprintf(alert->machine, sizeof(alert->machine), "%.*s (%.*s)", 56, machine_name, 32, machine_code);
    } else {
        snprintf(alert->machine, sizeof(alert->machine), "%.*s", 90, machine_name);
    }

    snprintf(alert->issue, sizeof(alert->issue), "%.*s / %.*s", 44, issue_category, 44, issue_problem);

    const char *status_keys[] = { "status" };
    const char *status_label_keys[] = { "status_label" };
    const char *action_keys[] = { "action_available" };
    const char *responder_keys[] = { "responder_name_text", "responder_name" };
    const char *message_keys[] = { "display_message", "operator_note", "command_label" };

    get_string_fallback(item, status_keys, 1, alert->status, sizeof(alert->status), "UNKNOWN");
    get_string_fallback(item, status_label_keys, 1, alert->status_label, sizeof(alert->status_label), alert->status);
    get_string_fallback(item, action_keys, 1, alert->action_available, sizeof(alert->action_available), "");
    get_string_fallback(item, responder_keys, 2, alert->responder_name, sizeof(alert->responder_name), "");
    get_string_fallback(item, message_keys, 3, alert->message, sizeof(alert->message), "");

    alert->elapsed_seconds = infer_elapsed_from_json(item);

    /*
     * Pager is allowed to acknowledge only.
     * Closing/resolving must be done at the machine/web app.
     */
    alert->actionable =
        strcasecmp(alert->action_available, "acknowledge") == 0;

    return true;
}

static bool parse_alerts_json(const char *json, andon_alert_t *alerts, size_t *out_count)
{
    static char sanitized[HTTP_BUFFER_SIZE];

    if (!extract_json_payload(json, sanitized, sizeof(sanitized))) {
        ESP_LOGE(TAG, "JSON payload not found. Raw preview: %.160s", json ? json : "(null)");
        return false;
    }

    cJSON *root = cJSON_Parse(sanitized);
    if (!root) {
        ESP_LOGE(TAG, "Invalid JSON. Sanitized preview: %.160s", sanitized);
        return false;
    }

    cJSON *success = cJSON_GetObjectItemCaseSensitive(root, "success");
    if (!cJSON_IsBool(success) || !cJSON_IsTrue(success)) {
        ESP_LOGE(TAG, "success=false or missing");
        cJSON_Delete(root);
        return false;
    }

    cJSON *array = cJSON_GetObjectItemCaseSensitive(root, "data");
    if (!cJSON_IsArray(array)) {
        ESP_LOGE(TAG, "data array missing");
        cJSON_Delete(root);
        return false;
    }

    size_t count = 0;
    cJSON *item = NULL;

    cJSON_ArrayForEach(item, array) {
        if (count >= MAX_ALERTS) {
            break;
        }

        if (parse_alert_item(item, &alerts[count])) {
            count++;
        }
    }

    *out_count = count;
    cJSON_Delete(root);

    ESP_LOGI(TAG, "Parsed %u alerts from API", (unsigned int)count);
    return true;
}

static esp_err_t http_event_handler(esp_http_client_event_t *evt)
{
    /* These were ESP_LOGI. Four UART lines per poll, every 45 s, forever is
     * real CPU and UART power for information only needed while debugging;
     * raise the level for this tag to DEBUG to get them back. */
    switch (evt->event_id) {
        case HTTP_EVENT_ON_CONNECTED:
            ESP_LOGD(TAG, "HTTP event: CONNECTED");   // did TCP connect succeed?
            break;
        case HTTP_EVENT_HEADER_SENT:
            ESP_LOGD(TAG, "HTTP event: HEADER_SENT"); // did we send the request?
            break;
        case HTTP_EVENT_ON_HEADER:
            ESP_LOGD(TAG, "HTTP event: ON_HEADER");   // did we get response headers?
            break;
        case HTTP_EVENT_ON_DATA:
            ESP_LOGD(TAG, "HTTP event: ON_DATA len=%d", evt->data_len);  // did we get body?
            break;
        default:
            break;
    }
    if (evt->event_id == HTTP_EVENT_ON_DATA && evt->data && evt->data_len > 0) {
        int remaining = HTTP_BUFFER_SIZE - 1 - g_http_response_len;

        if (remaining <= 0) {
            g_http_response_truncated = true;
            return ESP_OK;
        }

        int copy_len = evt->data_len;
        if (copy_len > remaining) {
            copy_len = remaining;
            g_http_response_truncated = true;
        }

        memcpy(g_http_response + g_http_response_len, evt->data, copy_len);
        g_http_response_len += copy_len;
        g_http_response[g_http_response_len] = '\0';
    }

    return ESP_OK;
}

static esp_err_t init_http_clients(void)
{
    if (g_get_client && g_post_client) {
        return ESP_OK;
    }

    ESP_LOGI(TAG, "Initializing HTTP clients. API_BASE_URL=%s", API_BASE_URL);

    esp_http_client_config_t config = {
        .url = "http://192.168.26.2:5003",
        .timeout_ms = 5000,
        .event_handler = http_event_handler,
    };

    if (!g_get_client) {
        g_get_client = esp_http_client_init(&config);
        if (!g_get_client) {
            ESP_LOGE(TAG, "Failed to initialize GET HTTP client");
            return ESP_FAIL;
        }
    }

    if (!g_post_client) {
        g_post_client = esp_http_client_init(&config);
        if (!g_post_client) {
            ESP_LOGE(TAG, "Failed to initialize POST HTTP client");
            return ESP_FAIL;
        }
    }

    return ESP_OK;
}

static esp_err_t http_request(const char *method, const char *path, const char *body, int *status_code)
{
    if (init_http_clients() != ESP_OK) {
        return ESP_FAIL;
    }

    esp_http_client_handle_t client = NULL;
    char url[320];
    char auth_header[256];

    snprintf(url, sizeof(url), "%s%s", API_BASE_URL, path);
    snprintf(auth_header, sizeof(auth_header), "Bearer %s", PAGER_TOKEN);

    g_http_response[0] = '\0';
    g_http_response_len = 0;
    g_http_response_truncated = false;

    if (status_code) {
        *status_code = -1;
    }

    if (strcmp(method, "GET") == 0) {
        client = g_get_client;
        esp_http_client_set_method(client, HTTP_METHOD_GET);
    } else if (strcmp(method, "POST") == 0) {
        client = g_post_client;
        esp_http_client_set_method(client, HTTP_METHOD_POST);
    } else {
        return ESP_ERR_INVALID_ARG;
    }

    esp_http_client_set_url(client, url);
    esp_http_client_set_header(client, "Authorization", auth_header);
    esp_http_client_set_header(client, "Accept", "application/json");
    /* Force Connection: close so every request opens a fresh TCP connection.
     * The working Polytex build did this; connection reuse appears to leave a
     * half-open socket that stalls the next handshake. */
    esp_http_client_set_header(client, "Connection", "close");
    if (body) {
        esp_http_client_set_header(client, "Content-Type", "application/json");
        esp_http_client_set_post_field(client, body, strlen(body));
    } else {
        esp_http_client_set_post_field(client, NULL, 0);
    }

    ESP_LOGI(TAG, "HTTP request begin: %s %s", method, url);

    esp_err_t err = esp_http_client_perform(client);

    if (status_code) {
        *status_code = esp_http_client_get_status_code(client);
    }

    if (err == ESP_OK && g_http_response_truncated) {
        ESP_LOGE(TAG, "HTTP response truncated");
        return ESP_FAIL;
    }

    ESP_LOGI(TAG, "HTTP %s %s status=%d bytes=%d err=%s",
             method,
             path,
             status_code ? *status_code : -1,
             g_http_response_len,
             esp_err_to_name(err));

    if (g_http_response_len > 0) {
        ESP_LOGD(TAG, "HTTP response preview: %.160s", g_http_response);
    }

    return err;
}

/* Produces a short, on-screen-safe string identifying the actual HTTP or
 * transport failure. The LCD's old generic status text ("API/network
 * error") covered a dead connection, a timeout, a truncated response, and
 * any unmapped HTTP status (401, 500, etc.) all identically - this makes
 * the LCD itself show which one happened, not just the serial log. */
static const char *http_err_short(esp_err_t err, int status_code)
{
    static char buf[40];

    if (err == ESP_ERR_HTTP_CONNECT) {
        return "Net: TCP connect fail";
    }
    if (err == ESP_ERR_HTTP_EAGAIN) {
        return "Net: timeout";
    }
    if (err == ESP_FAIL && g_http_response_truncated) {
        return "Net: response too large";
    }
    if (err != ESP_OK) {
        snprintf(buf, sizeof(buf), "Net: %s", esp_err_to_name(err));
        return buf;
    }

    snprintf(buf, sizeof(buf), "API HTTP %d", status_code);
    return buf;
}

static bool fetch_alerts(void)
{
    ESP_LOGI(TAG, "Fetching active alerts...");

    int status_code = -1;
    esp_err_t err = http_request("GET", "/api/andon/pager/alerts/active", NULL, &status_code);

    g_last_http_status = status_code;
    g_last_transport_error = (err != ESP_OK);

    if (err != ESP_OK || status_code < 200 || status_code >= 300) {
        if (status_code == 403) {
            snprintf(g_last_http_reason, sizeof(g_last_http_reason), "auth_403");
            set_status_text("Auth failed: check token", LV_COLOR_MAKE(0xB7, 0x1C, 0x1C));
        } else if (status_code == 404) {
            snprintf(g_last_http_reason, sizeof(g_last_http_reason), "scope_404");
            set_status_text("Pager scope not found", LV_COLOR_MAKE(0xB7, 0x1C, 0x1C));
        } else if (status_code == 409) {
            snprintf(g_last_http_reason, sizeof(g_last_http_reason), "race_409");
            set_status_text("State conflict", LV_COLOR_MAKE(0xB7, 0x1C, 0x1C));
        } else {
            snprintf(g_last_http_reason, sizeof(g_last_http_reason), "net_err");
            set_status_text(http_err_short(err, status_code), LV_COLOR_MAKE(0xB7, 0x1C, 0x1C));
        }

        ESP_LOGE(TAG, "Fetch failed: err=%s status=%d", esp_err_to_name(err), status_code);
        return false;
    }

    size_t parsed_count = 0;
    if (!parse_alerts_json(g_http_response, g_parse_alerts, &parsed_count)) {
        snprintf(g_last_http_reason, sizeof(g_last_http_reason), "json_err");
        set_status_text("API JSON error", LV_COLOR_MAKE(0xB7, 0x1C, 0x1C));
        ESP_LOGE(TAG, "Bad JSON preview: %.160s", g_http_response);
        return false;
    }

    size_t filtered_count = 0;

    for (size_t i = 0; i < parsed_count && filtered_count < MAX_ALERTS; i++) {
        if (is_recently_resolved_suppressed(g_parse_alerts[i].id)) {
            ESP_LOGW(TAG, "Suppressing recently resolved alert id=%s", g_parse_alerts[i].id);
            continue;
        }

        if (!alert_matches_machine_filter(&g_parse_alerts[i])) {
            ESP_LOGI(TAG,
                     "Ignoring out-of-scope machine alert id=%s machine='%s' code='%s' wanted='%s'",
                     g_parse_alerts[i].id,
                     g_parse_alerts[i].machine_name,
                     g_parse_alerts[i].machine_code,
                     PAGER_MACHINE_FILTER);
            continue;
        }

        /* A successful ACK can take a moment to appear in the next GET.
         * During that grace period, do not allow a stale OPEN response to
         * revert the local state or trigger the motor again. */
        if (is_recently_acknowledged_suppressed(g_parse_alerts[i].id)) {
            if (strcasecmp(g_parse_alerts[i].status, "OPEN") == 0) {
                ESP_LOGW(TAG, "Holding local ACK while backend still reports OPEN id=%s",
                         g_parse_alerts[i].id);
                snprintf(g_parse_alerts[i].status, sizeof(g_parse_alerts[i].status), "ACKNOWLEDGED");
                snprintf(g_parse_alerts[i].status_label, sizeof(g_parse_alerts[i].status_label), "Acknowledged");
                g_parse_alerts[i].action_available[0] = '\0';
                g_parse_alerts[i].actionable = false;
                snprintf(g_parse_alerts[i].responder_name, sizeof(g_parse_alerts[i].responder_name),
                         "%s", PAGER_RESPONDER_NAME);
            } else {
                /* The backend has caught up; the grace window is no longer needed. */
                clear_recent_ack_if_matches(g_parse_alerts[i].id);
            }
        }

        g_filtered_alerts[filtered_count++] = g_parse_alerts[i];
    }

    uint32_t new_hash = alert_state_hash(g_filtered_alerts, filtered_count);
    bool changed = (new_hash != g_alert_hash);

    ESP_LOGI(TAG,
             "Fetch result: parsed=%u filtered=%u changed=%d",
             (unsigned int)parsed_count,
             (unsigned int)filtered_count,
             changed ? 1 : 0);

    size_t unacked_open_count_after_fetch = 0;
    for (size_t i = 0; i < filtered_count; i++) {
        if (alert_is_unacknowledged_open(&g_filtered_alerts[i])) {
            unacked_open_count_after_fetch++;
        }
    }
    ESP_LOGI(TAG,
             "Unacknowledged OPEN alerts after fetch=%u",
             (unsigned int)unacked_open_count_after_fetch);

    if (unacked_open_count_after_fetch > 0) {
        /* Stay fully awake until this OPEN state is gone; after that, use the
         * normal two-minute grace instead of immediately re-entering sleep. */
        g_timer_wakeup_boot = false;
    }

    if (changed) {
        memcpy(g_alerts, g_filtered_alerts, filtered_count * sizeof(andon_alert_t));
        g_alert_count = filtered_count;
        g_alert_hash = new_hash;
        g_ui_dirty = true;

        if (g_detail_mode && find_alert_index_by_id(g_selected_alert_id) < 0) {
            g_detail_mode = false;
            g_selected_alert_id[0] = '\0';
        }

        if (g_page_offset >= g_alert_count) {
            g_page_offset = 0;
        }

        /* A timer-only maintenance wake should not flash the backlight for
         * ACKNOWLEDGED/ARRIVED state. OPEN alerts still wake it below. */
        if (!g_timer_wakeup_boot || unacked_open_count_after_fetch > 0) {
            wake_display_for_event();
        }
        apply_alert_signal_state();
    } else {
        memcpy(g_alerts, g_filtered_alerts, filtered_count * sizeof(andon_alert_t));
        g_alert_count = filtered_count;
    }

    g_last_sync_ms = now_ms();
    g_last_transport_error = false;
    g_initial_sync_complete = true;
    snprintf(g_last_http_reason, sizeof(g_last_http_reason), "ok");

    if (g_alert_count == 0) {
        set_status_text("No Press 14 alerts", LV_COLOR_MAKE(0x2E, 0x7D, 0x32));
    } else if (g_alert_count == 1) {
        set_status_text("1 active alert", LV_COLOR_MAKE(0x2E, 0x7D, 0x32));
    } else {
        char status[48];
        snprintf(status, sizeof(status), "%u active alerts", (unsigned int)g_alert_count);
        set_status_text(status, LV_COLOR_MAKE(0x2E, 0x7D, 0x32));
    }

    return true;
}

static bool post_alert_action(const andon_alert_t *alert)
{
    if (!alert || alert->id[0] == '\0') {
        return false;
    }

    char path[180];
    char body[256];

    if (strcasecmp(alert->action_available, "acknowledge") == 0) {
        snprintf(path,
                 sizeof(path),
                 "/api/andon/pager/alerts/%s/acknowledge",
                 alert->id);
        snprintf(body,
                 sizeof(body),
                 "{\"responder_name_text\":\"%s\",\"note\":\"Acknowledged on department pager\"}",
                 PAGER_RESPONDER_NAME);
    } else if (strcasecmp(alert->action_available, "resolve") == 0) {
        ESP_LOGW(TAG, "Resolve requested on pager, but pager close is disabled. id=%s", alert->id);
        set_status_text("Close at machine", LV_COLOR_MAKE(0xE6, 0x51, 0x00));
        return false;
    } else {
        ESP_LOGE(TAG, "Unsupported action: %s", alert->action_available);
        return false;
    }

    ESP_LOGI(TAG, "Posting alert action. id=%s action=%s", alert->id, alert->action_available);

    int status_code = -1;
    esp_err_t err = http_request("POST", path, body, &status_code);

    g_last_http_status = status_code;
    g_last_transport_error = (err != ESP_OK);

    if (err != ESP_OK || status_code < 200 || status_code >= 300) {
        if (status_code == 403) {
            snprintf(g_last_http_reason, sizeof(g_last_http_reason), "auth_403");
            set_status_text("Token/Auth failed", LV_COLOR_MAKE(0xB7, 0x1C, 0x1C));
        } else if (status_code == 404) {
            snprintf(g_last_http_reason, sizeof(g_last_http_reason), "scope_404");
            set_status_text("Alert not in scope", LV_COLOR_MAKE(0xB7, 0x1C, 0x1C));
        } else if (status_code == 409) {
            snprintf(g_last_http_reason, sizeof(g_last_http_reason), "race_409");
            set_status_text("Already changed", LV_COLOR_MAKE(0xB7, 0x1C, 0x1C));
        } else {
            snprintf(g_last_http_reason, sizeof(g_last_http_reason), "post_err");
            set_status_text(http_err_short(err, status_code), LV_COLOR_MAKE(0xB7, 0x1C, 0x1C));
        }

        ESP_LOGE(TAG, "POST action failed: err=%s status=%d", esp_err_to_name(err), status_code);
        return false;
    }

    static char sanitized[HTTP_BUFFER_SIZE];

    if (!extract_json_payload(g_http_response, sanitized, sizeof(sanitized))) {
        snprintf(g_last_http_reason, sizeof(g_last_http_reason), "json_err");
        ESP_LOGE(TAG, "POST response JSON payload not found");
        return false;
    }

    cJSON *root = cJSON_Parse(sanitized);
    if (!root) {
        snprintf(g_last_http_reason, sizeof(g_last_http_reason), "json_err");
        ESP_LOGE(TAG, "POST response invalid JSON");
        return false;
    }

    cJSON *success = cJSON_GetObjectItemCaseSensitive(root, "success");
    bool ok = cJSON_IsBool(success) && cJSON_IsTrue(success);
    cJSON_Delete(root);

    if (!ok) {
        snprintf(g_last_http_reason, sizeof(g_last_http_reason), "api_fail");
        ESP_LOGE(TAG, "POST response success=false or missing");
        return false;
    }

    snprintf(g_last_http_reason, sizeof(g_last_http_reason), "ok");
    return true;
}

static void optimistic_apply_action(const andon_alert_t *action_alert)
{
    int index = find_alert_index_by_id(action_alert->id);

    if (index < 0) {
        return;
    }

    if (strcasecmp(action_alert->action_available, "acknowledge") == 0) {
        snprintf(g_recently_acknowledged_id, sizeof(g_recently_acknowledged_id), "%s", action_alert->id);
        g_recently_acknowledged_until_ms = now_ms() + ACK_SYNC_GRACE_MS;

        snprintf(g_alerts[index].status, sizeof(g_alerts[index].status), "ACKNOWLEDGED");
        snprintf(g_alerts[index].status_label, sizeof(g_alerts[index].status_label), "Acknowledged");
        /*
         * Pager acknowledges only. The alert stays visible in the main list
         * with instructions to close it at the machine/web app.
         */
        g_alerts[index].action_available[0] = '\0';
        snprintf(g_alerts[index].responder_name, sizeof(g_alerts[index].responder_name), "%s", PAGER_RESPONDER_NAME);
        g_alerts[index].elapsed_seconds = 0;
        g_last_sync_ms = now_ms();
        g_alerts[index].actionable = false;
        g_selected_alert_id[0] = '\0';
        g_detail_mode = false;
        g_page_offset = ((size_t)index / VISIBLE_CARDS) * VISIBLE_CARDS;
        stop_alert_vibration();
    } else if (strcasecmp(action_alert->action_available, "resolve") == 0) {
        for (size_t i = (size_t)index; i + 1 < g_alert_count; i++) {
            g_alerts[i] = g_alerts[i + 1];
        }

        if (g_alert_count > 0) {
            g_alert_count--;
        }

        snprintf(g_recently_resolved_id, sizeof(g_recently_resolved_id), "%s", action_alert->id);
        g_recently_resolved_until_ms = now_ms() + RESOLVED_SUPPRESS_MS;
        g_selected_alert_id[0] = '\0';
        g_detail_mode = false;
        g_page_offset = 0;
    }

    g_alert_hash = alert_state_hash(g_alerts, g_alert_count);
    apply_alert_signal_state();
    g_ui_dirty = true;
}

static void process_action_queue(void)
{
    if (!g_wifi_connected || !g_action_queue) {
        return;
    }

    andon_alert_t action_alert;

    if (xQueueReceive(g_action_queue, &action_alert, 0) != pdTRUE) {
        return;
    }

    ESP_LOGI(TAG, "Processing action queue. id=%s action=%s",
             action_alert.id,
             action_alert.action_available);

    g_action_in_flight = true;
    g_ui_dirty = true;
    render_alerts();

    set_status_text("Sending...", LV_COLOR_MAKE(0xE6, 0x51, 0x00));

    bool ok = post_alert_action(&action_alert);

    if (!ok) {
        /* Let the real OPEN state return so the user can retry the ACK. */
        clear_recent_ack_if_matches(action_alert.id);
        set_status_text("Action failed, refreshing", LV_COLOR_MAKE(0xB7, 0x1C, 0x1C));
    }

    fetch_alerts();

    if (ok && strcasecmp(action_alert.action_available, "acknowledge") == 0) {
        char instruction[160];
        snprintf(instruction,
                 sizeof(instruction),
                 "Go to %.*s\nto close alert",
                 96,
                 action_alert.machine);
        stop_alert_vibration();
        g_selected_alert_id[0] = '\0';
        g_detail_mode = false;
        set_status_text("Go to machine to close alert", LV_COLOR_MAKE(0xE6, 0x51, 0x00));
        show_instruction_banner(instruction);
    }

    g_action_in_flight = false;
    g_ui_dirty = true;
}

static void render_card(size_t slot, int alert_index, bool detail)
{
    if (slot >= VISIBLE_CARDS || alert_index < 0 || alert_index >= (int)g_alert_count) {
        return;
    }

    andon_alert_t *alert = &g_alerts[alert_index];
    lv_obj_t *btn = g_card_btn[slot];
    lv_obj_t *label = g_card_label[slot];

    g_card_alert_index[slot] = alert_index;

    int total_elapsed = clamp_elapsed(
        alert->elapsed_seconds + (int)((now_ms() - g_last_sync_ms) / 1000)
    );

    char elapsed[24];
    elapsed_to_text(total_elapsed, elapsed, sizeof(elapsed));

    if (detail) {
        lv_obj_set_size(btn, 312, 150);
        lv_obj_set_pos(btn, 0, 0);
    } else {
        lv_obj_set_size(btn, 150, 72);
        int col = (int)(slot % 2);
        int row = (int)(slot / 2);
        lv_obj_set_pos(btn, col * 156, row * 78);
    }

    lv_obj_set_hidden(btn, false);
    lv_obj_set_click(btn, !g_action_in_flight);

    lv_obj_set_style_local_radius(btn, LV_BTN_PART_MAIN, LV_STATE_DEFAULT, 8);
    lv_obj_set_style_local_bg_color(btn, LV_BTN_PART_MAIN, LV_STATE_DEFAULT, color_for_alert_status(alert->status));
    lv_obj_set_style_local_bg_color(btn, LV_BTN_PART_MAIN, LV_STATE_PRESSED, LV_COLOR_MAKE(0xE3, 0xF2, 0xFD));
    lv_obj_set_style_local_border_width(btn, LV_BTN_PART_MAIN, LV_STATE_DEFAULT, detail ? 3 : 2);
    lv_obj_set_style_local_border_color(btn, LV_BTN_PART_MAIN, LV_STATE_DEFAULT, border_color_for_alert_status(alert->status));
    lv_obj_set_style_local_shadow_width(btn, LV_BTN_PART_MAIN, LV_STATE_DEFAULT, 6);
    lv_obj_set_style_local_shadow_color(btn, LV_BTN_PART_MAIN, LV_STATE_DEFAULT, LV_COLOR_MAKE(0xB0, 0xB7, 0xC3));

    lv_label_set_long_mode(label, LV_LABEL_LONG_BREAK);
    lv_label_set_align(label, LV_LABEL_ALIGN_LEFT);
    lv_obj_set_style_local_text_color(label, LV_LABEL_PART_MAIN, LV_STATE_DEFAULT, LV_COLOR_BLACK);
    lv_obj_set_width(label, detail ? 292 : 134);

    if (detail) {
        char line4[128];
        char message_line[128];

        if (alert_needs_web_clear_instruction(alert) && !alert->actionable) {
            snprintf(line4, sizeof(line4), "Please go to machine to close");
        } else if (alert->responder_name[0] != '\0') {
            snprintf(line4, sizeof(line4), "Responder: %s", alert->responder_name);
        } else if (strcasecmp(alert->status, "OPEN") == 0) {
            snprintf(line4, sizeof(line4), "Responder: Unassigned");
        } else {
            snprintf(line4, sizeof(line4), "Responder: -");
        }

        if (alert->message[0] != '\0') {
            snprintf(message_line, sizeof(message_line), "%.*s", 112, alert->message);
        } else {
            snprintf(message_line, sizeof(message_line), "%.*s", 112, alert->issue);
        }

        lv_label_set_text_fmt(label,
                              "%s\n%s\n%s  %s\n%s",
                              alert->machine,
                              message_line,
                              alert->status_label,
                              elapsed,
                              line4);
    } else {
        lv_label_set_text_fmt(label,
                              "%s\n%s  %s",
                              alert->machine,
                              alert->status_label,
                              elapsed);
    }

    lv_obj_align(label, btn, LV_ALIGN_IN_LEFT_MID, 8, 0);
}

static void render_alerts(void)
{
    static int64_t last_minute_render_ms = 0;
    int64_t now = now_ms();
    bool instruction_pending = g_instruction_until_ms > 0;

    if (!g_ui_dirty && !instruction_pending && g_display_brightness == 0) {
        return;
    }

    if (!g_ui_dirty && !instruction_pending && now - last_minute_render_ms < 60000) {
        return;
    }

    last_minute_render_ms = now;

    if (pdTRUE != xSemaphoreTake(xGuiSemaphore, portMAX_DELAY)) {
        return;
    }

    bool instruction_visible = g_instruction_until_ms > 0 && now < g_instruction_until_ms;
    if (g_instruction_banner) {
        lv_obj_set_hidden(g_instruction_banner, !instruction_visible);
        if (instruction_visible) {
            lv_obj_move_foreground(g_instruction_banner);
        } else {
            g_instruction_until_ms = 0;
        }
    }

    if (g_busy_overlay) {
        lv_obj_set_hidden(g_busy_overlay, !g_action_in_flight);
        if (g_action_in_flight) {
            lv_obj_move_foreground(g_busy_overlay);
        }
    }

    if (g_page_offset >= g_alert_count) {
        g_page_offset = 0;
    }

    for (size_t i = 0; i < VISIBLE_CARDS; i++) {
        g_card_alert_index[i] = -1;
        lv_obj_set_hidden(g_card_btn[i], true);
    }

    bool detail = false;
    int selected_index = -1;

    if (g_detail_mode) {
        selected_index = find_alert_index_by_id(g_selected_alert_id);
        if (selected_index >= 0) {
            detail = true;
        } else {
            g_detail_mode = false;
            g_selected_alert_id[0] = '\0';
        }
    }

    if (g_alert_count == 0) {
        lv_obj_set_hidden(g_empty_label, false);
        lv_label_set_text(g_empty_label, "Press 14 all clear\nPager is listening");

        lv_obj_set_hidden(g_action_btn, true);
        lv_obj_set_hidden(g_back_btn, true);
        lv_obj_set_hidden(g_prev_btn, true);
        lv_obj_set_hidden(g_next_btn, true);
        lv_obj_set_hidden(g_page_label, true);

        xSemaphoreGive(xGuiSemaphore);
        g_ui_dirty = false;
        return;
    }

    lv_obj_set_hidden(g_empty_label, true);

    if (detail) {
        render_card(0, selected_index, true);

        andon_alert_t *alert = &g_alerts[selected_index];

        lv_obj_set_hidden(g_prev_btn, true);
        lv_obj_set_hidden(g_next_btn, true);
        lv_obj_set_hidden(g_page_label, true);

        lv_obj_set_hidden(g_back_btn, false);
        lv_obj_set_click(g_back_btn, !g_action_in_flight);

        if (alert->actionable && !g_action_in_flight) {
            lv_obj_set_hidden(g_action_btn, false);
            lv_obj_set_click(g_action_btn, true);

            if (strcasecmp(alert->action_available, "acknowledge") == 0) {
                lv_label_set_text(g_action_label, "Acknowledge");
                lv_obj_set_style_local_bg_color(g_action_btn, LV_BTN_PART_MAIN, LV_STATE_DEFAULT, LV_COLOR_MAKE(0xFF, 0xB3, 0x00));
                lv_obj_set_style_local_bg_color(g_action_btn, LV_BTN_PART_MAIN, LV_STATE_PRESSED, LV_COLOR_MAKE(0xFB, 0x8C, 0x00));
            }
        } else {
            lv_obj_set_hidden(g_action_btn, true);
        }
    } else {
        for (size_t slot = 0; slot < VISIBLE_CARDS; slot++) {
            size_t alert_index = g_page_offset + slot;
            if (alert_index >= g_alert_count) {
                break;
            }

            render_card(slot, (int)alert_index, false);
        }

        lv_obj_set_hidden(g_action_btn, true);
        lv_obj_set_hidden(g_back_btn, true);

        bool has_pages = g_alert_count > VISIBLE_CARDS;
        lv_obj_set_hidden(g_prev_btn, !has_pages || g_page_offset == 0);
        lv_obj_set_hidden(g_next_btn, !has_pages || (g_page_offset + VISIBLE_CARDS >= g_alert_count));
        lv_obj_set_hidden(g_page_label, !has_pages);

        if (has_pages) {
            size_t first = g_page_offset + 1;
            size_t last = g_page_offset + VISIBLE_CARDS;
            if (last > g_alert_count) {
                last = g_alert_count;
            }
            lv_label_set_text_fmt(g_page_label, "%u-%u of %u",
                                  (unsigned int)first,
                                  (unsigned int)last,
                                  (unsigned int)g_alert_count);
        }
    }

    xSemaphoreGive(xGuiSemaphore);
    g_ui_dirty = false;
}

/*
 * AXP192 status registers used for charge detection.
 *
 * REG00 (power input status):
 *   bit7 ACIN present, bit5 VBUS present, bit2 battery current direction
 *        (1 = current flowing INTO the battery)
 * REG01 (power operating mode):
 *   bit6 charging indication (1 = charge engine running)
 *
 * The old code looked only at REG00 bit 2. That bit drops to 0 the moment the
 * charge terminates, so a full pack sitting on the charger looked identical to
 * a pack running down. It also depends on the battery-current ADC being
 * enabled, which the old Axp192_SetAdc1Enable(0x80) had switched off.
 */
#define AXP192_POWER_INPUT_STATUS_REG 0x00
#define AXP192_POWER_OP_MODE_REG      0x01
#define AXP192_ACIN_PRESENT_MASK      0x80
#define AXP192_VBUS_PRESENT_MASK      0x20
#define AXP192_BATTERY_CHARGING_MASK  0x04
#define AXP192_CHARGE_INDICATE_MASK   0x40

static void refresh_battery_label_locked(void)
{
    if (g_battery_percent < 0) {
        lv_label_set_text(g_battery_label, "--%");
    } else {
        lv_label_set_text_fmt(g_battery_label, "%d%%", g_battery_percent);
    }

    if (g_charging_icon) {
        /* Show the bolt whenever the pager is on external power, including
         * the "charge complete, still plugged in" case. */
        lv_obj_set_hidden(g_charging_icon, !(g_battery_is_charging || g_external_power));
    }
}

static void update_charging_indicator(void)
{
    /* The Core2 BSP header declares Axp192_ReadBytes() as void even though
     * its implementation returns bool. Use the correctly declared byte-read
     * wrapper to remain compatible with this BSP. A failed I2C read returns 0,
     * which safely displays battery operation rather than a false charging state. */
    uint8_t power_status = Axp192_Read8Bit(AXP192_POWER_INPUT_STATUS_REG);
    uint8_t op_mode = Axp192_Read8Bit(AXP192_POWER_OP_MODE_REG);

    bool external_power =
        (power_status & (AXP192_ACIN_PRESENT_MASK | AXP192_VBUS_PRESENT_MASK)) != 0;
    bool current_into_battery =
        (power_status & AXP192_BATTERY_CHARGING_MASK) != 0;
    bool charge_engine_running =
        (op_mode & AXP192_CHARGE_INDICATE_MASK) != 0;

    bool charging = charge_engine_running || (external_power && current_into_battery);

    ESP_LOGD(TAG,
             "AXP192 REG00=0x%02X REG01=0x%02X ext=%d dir=%d engine=%d -> charging=%d",
             power_status,
             op_mode,
             external_power ? 1 : 0,
             current_into_battery ? 1 : 0,
             charge_engine_running ? 1 : 0,
             charging ? 1 : 0);

    bool changed = !g_charge_status_valid ||
                   charging != g_battery_is_charging ||
                   external_power != g_external_power;

    g_charge_status_valid = true;
    g_battery_is_charging = charging;
    g_external_power = external_power;

    if (!changed) {
        return;
    }

    ESP_LOGI(TAG, "Charge state changed: charging=%d external=%d",
             charging ? 1 : 0, external_power ? 1 : 0);

    /* Terminal voltage steps as soon as the charger engages or drops out, and
     * the percentage curve applies a charging offset, so the filtered value
     * and the displayed percentage must both be recomputed now. */
    g_battery_snap_filter = true;
    g_force_battery_refresh = true;

    if (!g_battery_label || !g_charging_icon) {
        return;
    }

    if (pdTRUE == xSemaphoreTake(xGuiSemaphore, portMAX_DELAY)) {
        refresh_battery_label_locked();
        xSemaphoreGive(xGuiSemaphore);
    }
}

static void update_battery_indicator(void)
{
    if (!g_battery_fill || !g_battery_label) {
        return;
    }

    update_charging_indicator();

    /* One bad I2C transaction used to abort the entire refresh, which looked
     * exactly like a frozen percentage. Retry before giving up. */
    float voltage = -1.0f;

    for (int attempt = 0; attempt < BATTERY_SAMPLE_RETRIES; attempt++) {
        float sample = Core2ForAWS_PMU_GetBatVolt();

        if (sample >= 2.50f && sample <= 4.50f) {
            voltage = sample;
            break;
        }

        ESP_LOGW(TAG, "Invalid battery voltage sample %.3f V (attempt %d)",
                 sample, attempt + 1);
        vTaskDelay(pdMS_TO_TICKS(20));
    }

    if (voltage < 0.0f) {
        ESP_LOGE(TAG,
                 "Battery voltage unreadable. Verify Axp192_SetAdc1Enable bit 7 is set.");
        return;
    }

    /* Li-ion voltage sags briefly during Wi-Fi and motor activity. A small
     * low-pass filter keeps the displayed percentage from looking like it
     * lost several percent instantly even when the cell recovers afterward.
     *
     * The weight is 0.5 rather than 0.3 because the sample interval dropped
     * from 30 s to 5 s; at the old settings a genuine change took minutes to
     * reach the screen. */
    static bool have_filtered_voltage = false;
    static float filtered_voltage = 0.0f;

    if (!have_filtered_voltage || g_battery_snap_filter) {
        filtered_voltage = voltage;
        have_filtered_voltage = true;
        g_battery_snap_filter = false;
    } else if (fabsf(voltage - filtered_voltage) > 0.10f) {
        /* Large divergence means the filter is stale, not that a sample is
         * noisy. Snap to the real reading rather than crawling toward it. */
        filtered_voltage = voltage;
    } else {
        filtered_voltage = (filtered_voltage * 0.5f) + (voltage * 0.5f);
    }

    int pct = battery_percent_from_voltage(filtered_voltage, g_battery_is_charging);

    bool forced = g_force_battery_refresh;
    g_force_battery_refresh = false;

    ESP_LOGI(TAG, "Battery raw=%.3f V filtered=%.3f V pct=%d charging=%d ext=%d",
             voltage,
             filtered_voltage,
             pct,
             g_battery_is_charging ? 1 : 0,
             g_external_power ? 1 : 0);

    /* Skip the LVGL work when nothing changed, unless a wake or a charge-state
     * transition explicitly asked for a repaint. */
    if (pct == g_battery_percent && !forced) {
        return;
    }

    int fill_width = (BATTERY_FILL_MAX_W * pct) / 100;
    if (pct > 0 && fill_width < 2) {
        fill_width = 2;
    }
    if (fill_width > BATTERY_FILL_MAX_W) {
        fill_width = BATTERY_FILL_MAX_W;
    }

    lv_color_t color = battery_color_for_percent(pct);

    if (pdTRUE == xSemaphoreTake(xGuiSemaphore, portMAX_DELAY)) {
        if (fill_width <= 0) {
            lv_obj_set_hidden(g_battery_fill, true);
        } else {
            lv_obj_set_hidden(g_battery_fill, false);
            lv_obj_set_size(g_battery_fill, fill_width, 8);
            /* Re-align after the resize: LVGL v7 does not re-apply a previous
             * alignment automatically, so without this the bar drifts. */
            lv_obj_align(g_battery_fill, g_battery_body, LV_ALIGN_IN_LEFT_MID, 2, 0);
            lv_obj_set_style_local_bg_color(g_battery_fill, LV_CONT_PART_MAIN, LV_STATE_DEFAULT, color);
        }

        g_battery_percent = pct;
        refresh_battery_label_locked();
        lv_obj_set_style_local_text_color(g_battery_label, LV_LABEL_PART_MAIN, LV_STATE_DEFAULT, color);
        /* The label width changes between "9%", "99%" and "100%". */
        lv_obj_align(g_battery_label, g_battery_tip, LV_ALIGN_OUT_RIGHT_MID, 4, 0);
        lv_obj_invalidate(lv_scr_act());
        xSemaphoreGive(xGuiSemaphore);
    }
}

/*
 * Battery and charge state come from the local AXP192 over I2C and have no
 * dependency on Wi-Fi, the API, or the alert list. Previously this work lived
 * inside pager_task, which also blocks for up to 5 s inside
 * esp_http_client_perform() and services the Wi-Fi reconnect backoff. Giving
 * it a dedicated task means the indicator keeps updating at a fixed cadence
 * whatever the network is doing, including with no AP in range at all.
 */
static void power_monitor_task(void *arg)
{
    (void)arg;

    ESP_LOGI(TAG, "Power monitor task started");

    while (1) {
        update_battery_indicator();

        int interval_ms = (g_display_brightness == 0)
                              ? BATTERY_REFRESH_SCREEN_OFF_MS
                              : BATTERY_REFRESH_ACTIVE_MS;

        if (g_battery_wake_sem) {
            /* Returns early when a touch or an alert wakes the display, so the
             * first frame the user sees carries a fresh reading. */
            xSemaphoreTake(g_battery_wake_sem, pdMS_TO_TICKS(interval_ms));
        } else {
            vTaskDelay(pdMS_TO_TICKS(interval_ms));
        }
    }
}

static void build_ui(void)
{
    ESP_LOGI(TAG, "Building UI");

    /* Avoid a three-second backlight flash on the once-per-minute timer
     * maintenance boot. A touch/power boot still uses the normal brightness. */
    set_display_brightness(g_timer_wakeup_boot ? 0 : DISPLAY_ACTIVE_BRIGHTNESS);

    if (pdTRUE != xSemaphoreTake(xGuiSemaphore, portMAX_DELAY)) {
        ESP_LOGE(TAG, "Failed to take GUI semaphore during build_ui");
        return;
    }

    lv_obj_set_style_local_bg_color(lv_scr_act(), LV_OBJ_PART_MAIN, LV_STATE_DEFAULT, LV_COLOR_MAKE(0xF5, 0xF7, 0xFA));
    lv_obj_set_style_local_bg_opa(lv_scr_act(), LV_OBJ_PART_MAIN, LV_STATE_DEFAULT, LV_OPA_COVER);
    lv_obj_set_click(lv_scr_act(), false);

    g_title_label = lv_label_create(lv_scr_act(), NULL);
    lv_label_set_text(g_title_label, "Quality Press 14");
    lv_obj_set_style_local_text_color(g_title_label, LV_LABEL_PART_MAIN, LV_STATE_DEFAULT, LV_COLOR_MAKE(0x21, 0x21, 0x21));
    lv_obj_align(g_title_label, lv_scr_act(), LV_ALIGN_IN_TOP_LEFT, 6, 2);

    g_status_label = lv_label_create(lv_scr_act(), NULL);
    lv_label_set_text(g_status_label, "Starting...");
    lv_obj_set_style_local_text_color(g_status_label, LV_LABEL_PART_MAIN, LV_STATE_DEFAULT, LV_COLOR_MAKE(0xE6, 0x51, 0x00));
    lv_obj_align(g_status_label, lv_scr_act(), LV_ALIGN_IN_TOP_LEFT, 6, 19);

    g_battery_body = lv_cont_create(lv_scr_act(), NULL);
    lv_obj_set_size(g_battery_body, 28, 14);
    /* Leave room for the numeric percentage and charging bolt. */
    lv_obj_align(g_battery_body, lv_scr_act(), LV_ALIGN_IN_TOP_RIGHT, -76, 5);
    lv_obj_set_style_local_bg_opa(g_battery_body, LV_CONT_PART_MAIN, LV_STATE_DEFAULT, LV_OPA_TRANSP);
    /* Deliberately a fixed neutral grey: the outline must never be mistaken
     * for the low-battery colour, which belongs to the fill bar only. */
    lv_obj_set_style_local_border_color(g_battery_body, LV_CONT_PART_MAIN, LV_STATE_DEFAULT, LV_COLOR_MAKE(0x45, 0x45, 0x45));
    lv_obj_set_style_local_border_width(g_battery_body, LV_CONT_PART_MAIN, LV_STATE_DEFAULT, 2);
    lv_obj_set_style_local_radius(g_battery_body, LV_CONT_PART_MAIN, LV_STATE_DEFAULT, 2);
    lv_obj_set_style_local_pad_all(g_battery_body, LV_CONT_PART_MAIN, LV_STATE_DEFAULT, 0);

    g_battery_tip = lv_cont_create(lv_scr_act(), NULL);
    lv_obj_set_size(g_battery_tip, 3, 8);
    lv_obj_align(g_battery_tip, g_battery_body, LV_ALIGN_OUT_RIGHT_MID, 1, 0);
    lv_obj_set_style_local_bg_color(g_battery_tip, LV_CONT_PART_MAIN, LV_STATE_DEFAULT, LV_COLOR_MAKE(0x45, 0x45, 0x45));
    lv_obj_set_style_local_border_width(g_battery_tip, LV_CONT_PART_MAIN, LV_STATE_DEFAULT, 0);
    lv_obj_set_style_local_radius(g_battery_tip, LV_CONT_PART_MAIN, LV_STATE_DEFAULT, 1);

    g_battery_fill = lv_cont_create(g_battery_body, NULL);
    lv_obj_set_size(g_battery_fill, BATTERY_FILL_MAX_W, 8);
    /* 2 px inset clears the body's 2 px border on both sides; the old 3 px
     * inset pushed a full bar past the right-hand border. */
    lv_obj_align(g_battery_fill, g_battery_body, LV_ALIGN_IN_LEFT_MID, 2, 0);
    lv_obj_set_style_local_bg_color(g_battery_fill, LV_CONT_PART_MAIN, LV_STATE_DEFAULT, LV_COLOR_MAKE(0x43, 0xA0, 0x47));
    lv_obj_set_style_local_border_width(g_battery_fill, LV_CONT_PART_MAIN, LV_STATE_DEFAULT, 0);
    lv_obj_set_style_local_radius(g_battery_fill, LV_CONT_PART_MAIN, LV_STATE_DEFAULT, 1);

    g_battery_label = lv_label_create(lv_scr_act(), NULL);
    lv_label_set_text(g_battery_label, "--%");
    lv_obj_set_style_local_text_color(g_battery_label, LV_LABEL_PART_MAIN, LV_STATE_DEFAULT, LV_COLOR_MAKE(0x43, 0xA0, 0x47));
    lv_obj_align(g_battery_label, g_battery_tip, LV_ALIGN_OUT_RIGHT_MID, 4, 0);

    /* LVGL's built-in Font Awesome charging glyph is present in the bundled
     * font, so it does not depend on the active font containing Unicode U+26A1. */
    g_charging_icon = lv_label_create(lv_scr_act(), NULL);
    lv_label_set_text(g_charging_icon, LV_SYMBOL_CHARGE);
    lv_obj_set_style_local_text_color(g_charging_icon, LV_LABEL_PART_MAIN, LV_STATE_DEFAULT,
                                      LV_COLOR_MAKE(0xF9, 0xA8, 0x25));
    lv_obj_align(g_charging_icon, lv_scr_act(), LV_ALIGN_IN_TOP_RIGHT, -4, 3);
    lv_obj_set_hidden(g_charging_icon, true);

    g_list_area = lv_cont_create(lv_scr_act(), NULL);
    lv_obj_set_size(g_list_area, 312, 150);
    lv_obj_set_pos(g_list_area, 4, 40);
    lv_obj_set_style_local_bg_color(g_list_area, LV_CONT_PART_MAIN, LV_STATE_DEFAULT, LV_COLOR_MAKE(0xF5, 0xF7, 0xFA));
    lv_obj_set_style_local_bg_opa(g_list_area, LV_CONT_PART_MAIN, LV_STATE_DEFAULT, LV_OPA_COVER);
    lv_obj_set_style_local_border_width(g_list_area, LV_CONT_PART_MAIN, LV_STATE_DEFAULT, 0);
    lv_obj_set_click(g_list_area, false);
    lv_obj_set_drag(g_list_area, false);

    g_empty_label = lv_label_create(g_list_area, NULL);
    lv_label_set_text(g_empty_label, "Press 14 all clear\nPager is listening");
    lv_label_set_align(g_empty_label, LV_LABEL_ALIGN_CENTER);
    lv_obj_set_style_local_text_color(g_empty_label, LV_LABEL_PART_MAIN, LV_STATE_DEFAULT, LV_COLOR_MAKE(0x54, 0x6E, 0x7A));
    lv_obj_align(g_empty_label, g_list_area, LV_ALIGN_CENTER, 0, 0);

    for (size_t i = 0; i < VISIBLE_CARDS; i++) {
        g_card_alert_index[i] = -1;
        g_card_btn[i] = lv_btn_create(g_list_area, NULL);
        lv_obj_set_event_cb(g_card_btn[i], pager_event_handler);
        lv_obj_set_hidden(g_card_btn[i], true);

        g_card_label[i] = lv_label_create(g_card_btn[i], NULL);
        lv_label_set_long_mode(g_card_label[i], LV_LABEL_LONG_BREAK);
        lv_label_set_align(g_card_label[i], LV_LABEL_ALIGN_LEFT);
        lv_obj_set_style_local_text_color(g_card_label[i], LV_LABEL_PART_MAIN, LV_STATE_DEFAULT, LV_COLOR_BLACK);
    }

    g_back_btn = lv_btn_create(lv_scr_act(), NULL);
    lv_obj_set_size(g_back_btn, 86, 40);
    lv_obj_set_pos(g_back_btn, 4, 196);
    lv_obj_set_event_cb(g_back_btn, back_button_event_handler);
    lv_obj_set_style_local_radius(g_back_btn, LV_BTN_PART_MAIN, LV_STATE_DEFAULT, 8);
    lv_obj_set_style_local_bg_color(g_back_btn, LV_BTN_PART_MAIN, LV_STATE_DEFAULT, LV_COLOR_MAKE(0x64, 0xB5, 0xF6));
    lv_obj_set_style_local_bg_color(g_back_btn, LV_BTN_PART_MAIN, LV_STATE_PRESSED, LV_COLOR_MAKE(0x42, 0xA5, 0xF5));
    lv_obj_set_style_local_border_width(g_back_btn, LV_BTN_PART_MAIN, LV_STATE_DEFAULT, 2);
    lv_obj_set_style_local_border_color(g_back_btn, LV_BTN_PART_MAIN, LV_STATE_DEFAULT, LV_COLOR_BLACK);
    g_back_label = lv_label_create(g_back_btn, NULL);
    lv_label_set_text(g_back_label, "Back");
    lv_obj_set_style_local_text_color(g_back_label, LV_LABEL_PART_MAIN, LV_STATE_DEFAULT, LV_COLOR_BLACK);
    lv_obj_align(g_back_label, g_back_btn, LV_ALIGN_CENTER, 0, 0);
    lv_obj_set_hidden(g_back_btn, true);

    g_action_btn = lv_btn_create(lv_scr_act(), NULL);
    lv_obj_set_size(g_action_btn, 222, 40);
    lv_obj_set_pos(g_action_btn, 94, 196);
    lv_obj_set_event_cb(g_action_btn, action_button_event_handler);
    lv_obj_set_style_local_radius(g_action_btn, LV_BTN_PART_MAIN, LV_STATE_DEFAULT, 8);
    lv_obj_set_style_local_border_width(g_action_btn, LV_BTN_PART_MAIN, LV_STATE_DEFAULT, 2);
    lv_obj_set_style_local_border_color(g_action_btn, LV_BTN_PART_MAIN, LV_STATE_DEFAULT, LV_COLOR_BLACK);
    g_action_label = lv_label_create(g_action_btn, NULL);
    lv_label_set_text(g_action_label, "Acknowledge");
    lv_obj_set_style_local_text_color(g_action_label, LV_LABEL_PART_MAIN, LV_STATE_DEFAULT, LV_COLOR_BLACK);
    lv_obj_align(g_action_label, g_action_btn, LV_ALIGN_CENTER, 0, 0);
    lv_obj_set_hidden(g_action_btn, true);

    g_prev_btn = lv_btn_create(lv_scr_act(), NULL);
    lv_obj_set_size(g_prev_btn, 78, 40);
    lv_obj_set_pos(g_prev_btn, 4, 196);
    lv_obj_set_event_cb(g_prev_btn, page_prev_event_handler);
    lv_obj_set_style_local_radius(g_prev_btn, LV_BTN_PART_MAIN, LV_STATE_DEFAULT, 8);
    lv_obj_set_style_local_bg_color(g_prev_btn, LV_BTN_PART_MAIN, LV_STATE_DEFAULT, LV_COLOR_MAKE(0xCF, 0xD8, 0xDC));
    g_prev_label = lv_label_create(g_prev_btn, NULL);
    lv_label_set_text(g_prev_label, "Prev");
    lv_obj_set_style_local_text_color(g_prev_label, LV_LABEL_PART_MAIN, LV_STATE_DEFAULT, LV_COLOR_BLACK);
    lv_obj_align(g_prev_label, g_prev_btn, LV_ALIGN_CENTER, 0, 0);
    lv_obj_set_hidden(g_prev_btn, true);

    g_next_btn = lv_btn_create(lv_scr_act(), NULL);
    lv_obj_set_size(g_next_btn, 78, 40);
    lv_obj_set_pos(g_next_btn, 238, 196);
    lv_obj_set_event_cb(g_next_btn, page_next_event_handler);
    lv_obj_set_style_local_radius(g_next_btn, LV_BTN_PART_MAIN, LV_STATE_DEFAULT, 8);
    lv_obj_set_style_local_bg_color(g_next_btn, LV_BTN_PART_MAIN, LV_STATE_DEFAULT, LV_COLOR_MAKE(0xCF, 0xD8, 0xDC));
    g_next_label = lv_label_create(g_next_btn, NULL);
    lv_label_set_text(g_next_label, "Next");
    lv_obj_set_style_local_text_color(g_next_label, LV_LABEL_PART_MAIN, LV_STATE_DEFAULT, LV_COLOR_BLACK);
    lv_obj_align(g_next_label, g_next_btn, LV_ALIGN_CENTER, 0, 0);
    lv_obj_set_hidden(g_next_btn, true);

    g_page_label = lv_label_create(lv_scr_act(), NULL);
    lv_label_set_text(g_page_label, "");
    lv_obj_set_style_local_text_color(g_page_label, LV_LABEL_PART_MAIN, LV_STATE_DEFAULT, LV_COLOR_MAKE(0x54, 0x6E, 0x7A));
    lv_obj_align(g_page_label, lv_scr_act(), LV_ALIGN_IN_BOTTOM_MID, 0, -14);
    lv_obj_set_hidden(g_page_label, true);

    g_busy_overlay = lv_cont_create(lv_scr_act(), NULL);
    lv_obj_set_size(g_busy_overlay, 320, 240);
    lv_obj_set_pos(g_busy_overlay, 0, 0);
    lv_obj_set_style_local_bg_color(g_busy_overlay, LV_CONT_PART_MAIN, LV_STATE_DEFAULT, LV_COLOR_MAKE(0x1E, 0x88, 0xE5));
    lv_obj_set_style_local_bg_opa(g_busy_overlay, LV_CONT_PART_MAIN, LV_STATE_DEFAULT, LV_OPA_80);
    lv_obj_set_style_local_border_width(g_busy_overlay, LV_CONT_PART_MAIN, LV_STATE_DEFAULT, 0);
    lv_obj_set_click(g_busy_overlay, true);
    g_busy_label = lv_label_create(g_busy_overlay, NULL);
    lv_label_set_text(g_busy_label, "Sending...");
    lv_obj_set_style_local_text_color(g_busy_label, LV_LABEL_PART_MAIN, LV_STATE_DEFAULT, LV_COLOR_WHITE);
    lv_obj_align(g_busy_label, g_busy_overlay, LV_ALIGN_CENTER, 0, 0);
    lv_obj_set_hidden(g_busy_overlay, true);

    g_instruction_banner = lv_cont_create(lv_scr_act(), NULL);
    lv_obj_set_size(g_instruction_banner, 304, 96);
    lv_obj_set_pos(g_instruction_banner, 8, 58);
    lv_obj_set_style_local_bg_color(g_instruction_banner, LV_CONT_PART_MAIN, LV_STATE_DEFAULT, LV_COLOR_MAKE(0xFF, 0xF8, 0xE1));
    lv_obj_set_style_local_bg_opa(g_instruction_banner, LV_CONT_PART_MAIN, LV_STATE_DEFAULT, LV_OPA_COVER);
    lv_obj_set_style_local_border_width(g_instruction_banner, LV_CONT_PART_MAIN, LV_STATE_DEFAULT, 3);
    lv_obj_set_style_local_border_color(g_instruction_banner, LV_CONT_PART_MAIN, LV_STATE_DEFAULT, LV_COLOR_MAKE(0xFB, 0x8C, 0x00));
    lv_obj_set_style_local_radius(g_instruction_banner, LV_CONT_PART_MAIN, LV_STATE_DEFAULT, 10);
    lv_obj_set_click(g_instruction_banner, false);
    g_instruction_label = lv_label_create(g_instruction_banner, NULL);
    lv_label_set_long_mode(g_instruction_label, LV_LABEL_LONG_BREAK);
    lv_label_set_align(g_instruction_label, LV_LABEL_ALIGN_CENTER);
    lv_obj_set_width(g_instruction_label, 280);
    lv_label_set_text(g_instruction_label, "Please go to machine\nto close alert");
    lv_obj_set_style_local_text_color(g_instruction_label, LV_LABEL_PART_MAIN, LV_STATE_DEFAULT, LV_COLOR_MAKE(0x7C, 0x2D, 0x12));
#if LV_FONT_MONTSERRAT_20
    lv_obj_set_style_local_text_font(g_instruction_label, LV_LABEL_PART_MAIN, LV_STATE_DEFAULT, &lv_font_montserrat_20);
#endif
    lv_obj_align(g_instruction_label, g_instruction_banner, LV_ALIGN_CENTER, 0, 0);
    lv_obj_set_hidden(g_instruction_banner, true);

    xSemaphoreGive(xGuiSemaphore);

    /* First reading is unconditional: g_force_battery_refresh starts true. */
    update_battery_indicator();
    g_ui_dirty = true;

    ESP_LOGI(TAG, "UI built");
}

static void pager_event_handler(lv_obj_t *obj, lv_event_t event)
{
    if (event != LV_EVENT_RELEASED) {
        return;
    }

    record_user_activity();

    for (size_t slot = 0; slot < VISIBLE_CARDS; slot++) {
        if (obj != g_card_btn[slot]) {
            continue;
        }

        int alert_index = g_card_alert_index[slot];
        if (alert_index < 0 || alert_index >= (int)g_alert_count) {
            return;
        }

        andon_alert_t *alert = &g_alerts[alert_index];

        if (g_detail_mode && strcmp(g_selected_alert_id, alert->id) == 0) {
            g_selected_alert_id[0] = '\0';
            g_detail_mode = false;
        } else {
            snprintf(g_selected_alert_id, sizeof(g_selected_alert_id), "%s", alert->id);
            g_detail_mode = true;
        }

        g_ui_dirty = true;
        notify_pager_wake();
        return;
    }
}

static void back_button_event_handler(lv_obj_t *obj, lv_event_t event)
{
    (void)obj;

    if (event != LV_EVENT_RELEASED) {
        return;
    }

    record_user_activity();

    g_selected_alert_id[0] = '\0';
    g_detail_mode = false;
    g_ui_dirty = true;
    notify_pager_wake();
}

static void action_button_event_handler(lv_obj_t *obj, lv_event_t event)
{
    (void)obj;

    if (event != LV_EVENT_RELEASED || g_action_in_flight) {
        return;
    }

    record_user_activity();

    int selected_index = find_alert_index_by_id(g_selected_alert_id);
    if (selected_index < 0 || selected_index >= (int)g_alert_count) {
        ESP_LOGW(TAG, "Action tapped but selected alert not found");
        return;
    }

    andon_alert_t action_alert = g_alerts[selected_index];

    if (!action_alert.actionable) {
        ESP_LOGW(TAG, "Action tapped but alert not actionable. id=%s action=%s",
                 action_alert.id,
                 action_alert.action_available);
        return;
    }

    if (xQueueSend(g_action_queue, &action_alert, 0) != pdTRUE) {
        ESP_LOGW(TAG, "Action queue full");
        return;
    }

    g_action_in_flight = true;
    optimistic_apply_action(&action_alert);
    g_ui_dirty = true;

    /* Do not wait out the idle delay before the POST goes out. */
    notify_pager_wake();
}

static void page_prev_event_handler(lv_obj_t *obj, lv_event_t event)
{
    (void)obj;

    if (event != LV_EVENT_RELEASED) {
        return;
    }

    record_user_activity();

    if (g_page_offset >= VISIBLE_CARDS) {
        g_page_offset -= VISIBLE_CARDS;
    } else {
        g_page_offset = 0;
    }

    g_ui_dirty = true;
    notify_pager_wake();
}

static void page_next_event_handler(lv_obj_t *obj, lv_event_t event)
{
    (void)obj;

    if (event != LV_EVENT_RELEASED) {
        return;
    }

    record_user_activity();

    if (g_page_offset + VISIBLE_CARDS < g_alert_count) {
        g_page_offset += VISIBLE_CARDS;
    }

    g_ui_dirty = true;
    notify_pager_wake();
}

static void update_display_power(void)
{
    int64_t idle_ms = now_ms() - read_last_user_activity_ms();

    if (g_action_in_flight) {
        set_display_brightness(DISPLAY_ACTIVE_BRIGHTNESS);
        return;
    }

    /*
     * OPEN alert:
     * Wake brightly when the alert arrives, dim quickly, then turn the
     * backlight completely off. The alert remains active and vibration /
     * polling continue; a touch wakes the display again. Keeping the LCD
     * dim-but-on for the entire alert was one of the largest battery drains.
     */
    if (count_unacknowledged_open_alerts() > 0) {
        if (idle_ms >= DISPLAY_OFF_WITH_ALERT_MS) {
            set_display_brightness(0);
        } else if (idle_ms >= DISPLAY_DIM_WITH_ALERT_MS) {
            set_display_brightness(DISPLAY_DIM_BRIGHTNESS);
        } else {
            set_display_brightness(DISPLAY_ACTIVE_BRIGHTNESS);
        }
        return;
    }

    /*
     * No alerts: screen can turn completely off.
     */
    if (g_alert_count == 0) {
        if (idle_ms >= DISPLAY_OFF_NO_ALERT_MS) {
            set_display_brightness(0);
        } else {
            set_display_brightness(DISPLAY_ACTIVE_BRIGHTNESS);
        }
        return;
    }

    /*
     * ACKNOWLEDGED alerts:
     * Dim and eventually turn off normally.
     */
    if (idle_ms >= DISPLAY_OFF_WITH_ALERT_MS) {
        set_display_brightness(0);
    } else if (idle_ms >= DISPLAY_DIM_WITH_ALERT_MS) {
        set_display_brightness(DISPLAY_DIM_BRIGHTNESS);
    } else {
        set_display_brightness(DISPLAY_ACTIVE_BRIGHTNESS);
    }
}
static void wake_from_touch_activity(void)
{
    if (g_display_brightness >= DISPLAY_ACTIVE_BRIGHTNESS) {
        return;
    }

    /* GPIO39 is the FT6336U interrupt line. Checking it directly avoids
     * waiting for the touch-controller I2C update task; the driver state is
     * retained as a fallback for short interrupt pulses. */
    if (gpio_get_level(TOUCH_WAKE_GPIO) == 0 || FT6336U_WasPressed()) {
        ESP_LOGI(TAG, "Touch detected while display dim/off");
        record_user_activity();
        g_ui_dirty = true;
    }
}

/* This task must stay separate from pager_task: esp_http_client_perform() can
 * block pager_task for up to HTTP timeout_ms, but it must never block touch.
 * It is now the ONLY caller of wake_from_touch_activity(): pager_task used to
 * poll it as well, which both duplicated the GPIO/I2C read and could consume
 * the FT6336U pressed flag before this task saw it. */
static void touch_wake_task(void *arg)
{
    (void)arg;

    while (1) {
        wake_from_touch_activity();
        vTaskDelay(pdMS_TO_TICKS(TOUCH_WAKE_TASK_TICK_MS));
    }
}

static void maybe_deep_sleep_when_no_open(void)
{
#if ENABLE_DEEP_SLEEP_WHEN_NO_OPEN
    /* Never sleep on a stale all-clear view. Require a successful sync, no
     * unacknowledged OPEN alert, and no action waiting for the network. */
    if (!g_initial_sync_complete ||
        g_last_transport_error ||
        count_unacknowledged_open_alerts() > 0 ||
        g_action_in_flight ||
        !g_wifi_connected) {
        g_no_open_since_ms = 0;
        return;
    }

    int64_t now = now_ms();

    if (g_no_open_since_ms == 0) {
        g_no_open_since_ms = now;
    }

    /* A timer wake exists only to perform one verified server check. If the
     * result still has no OPEN alert, return directly to deep sleep. */
    if (!g_timer_wakeup_boot &&
        now - g_no_open_since_ms < DEEP_SLEEP_NO_OPEN_AFTER_MS) {
        return;
    }

    ESP_LOGW(TAG,
             "Entering deep sleep; next server check in %llu us",
             (unsigned long long)DEEP_SLEEP_WAKE_US);

    Core2ForAWS_Motor_SetStrength(0);
    set_display_brightness(0);
    set_led_idle();

    /* No AXP192 measurements are needed during deep sleep. Core2ForAWS_Init
     * restores the ADC configuration after either wake source resets the CPU. */
    Axp192_SetAdc1Enable(0x00);

    esp_wifi_stop();

    /* GPIO39 is the Core2/Core2-for-AWS FT6336U touch interrupt. It is
     * active-low and is RTC-capable, so a screen touch can wake the pager.
     * If it is already low, omit EXT0 for this cycle to avoid a reset loop. */
    esp_sleep_disable_wakeup_source(ESP_SLEEP_WAKEUP_ALL);
    esp_sleep_enable_timer_wakeup(DEEP_SLEEP_WAKE_US);
    gpio_set_direction(TOUCH_WAKE_GPIO, GPIO_MODE_INPUT);
    if (gpio_get_level(TOUCH_WAKE_GPIO) != 0) {
        esp_err_t touch_wake_err = esp_sleep_enable_ext0_wakeup(TOUCH_WAKE_GPIO, 0);
        if (touch_wake_err != ESP_OK) {
            ESP_LOGW(TAG, "Touch wake setup failed: %s", esp_err_to_name(touch_wake_err));
        }
    }

    esp_deep_sleep_start();
#else
    (void)g_no_open_since_ms;
#endif
}

static int current_poll_interval_ms(void)
{
    if (g_last_transport_error) {
        return POLL_ERROR_MS;
    }

    /*
     * Poll fast only while there are unacknowledged OPEN alerts.
     * ACKNOWLEDGED alerts stay visible, but they should not keep the pager
     * in the fast polling/vibration state.
     */
    if (count_unacknowledged_open_alerts() > 0) {
        return POLL_WITH_UNACKED_OPEN_MS;
    }

    return POLL_IDLE_MS;
}

static void init_power_management(void)
{
#if defined(CONFIG_PM_ENABLE)
    esp_pm_config_esp32_t pm_config = {
        .max_freq_mhz = 80,
        .min_freq_mhz = 10,
#if defined(CONFIG_FREERTOS_USE_TICKLESS_IDLE)
        .light_sleep_enable = true,
#else
        .light_sleep_enable = false,
#endif
    };

    esp_err_t err = esp_pm_configure(&pm_config);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "Power management config failed: %s", esp_err_to_name(err));
    } else {
        ESP_LOGI(TAG, "Power management configured");
    }
#else
    ESP_LOGW(TAG, "CONFIG_PM_ENABLE is off; automatic light sleep is disabled");
#endif

#if !defined(CONFIG_FREERTOS_USE_TICKLESS_IDLE)
    /* Without tickless idle the CPU wakes on every FreeRTOS tick, so the long
     * idle waits below save much less than they could. Enable
     * CONFIG_PM_ENABLE + CONFIG_FREERTOS_USE_TICKLESS_IDLE in sdkconfig to
     * get the full benefit. */
    ESP_LOGW(TAG, "Tickless idle is off; automatic light sleep cannot engage");
#endif
}

static void log_wifi_disconnect_reason(int reason)
{
    const char *meaning = "unknown";

    switch (reason) {
        case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT:
            meaning = "4-way handshake timeout, often password/security mismatch";
            break;
        case WIFI_REASON_BEACON_TIMEOUT:
            meaning = "beacon timeout / weak signal";
            break;
        case WIFI_REASON_NO_AP_FOUND:
            meaning = "no AP found / wrong SSID / 5 GHz only / out of range";
            break;
        case WIFI_REASON_AUTH_FAIL:
            meaning = "auth failed / wrong password";
            break;
        case WIFI_REASON_ASSOC_FAIL:
            meaning = "association failed";
            break;
        case WIFI_REASON_HANDSHAKE_TIMEOUT:
            meaning = "handshake timeout";
            break;
        default:
            meaning = "unmapped reason";
            break;
    }

    ESP_LOGW(TAG, "Wi-Fi disconnect reason=%d meaning=%s", reason, meaning);
}

static void schedule_wifi_reconnect(void)
{
    int64_t now = now_ms();

    if (now < g_next_wifi_reconnect_ms) {
        ESP_LOGI(TAG, "Reconnect skipped. Waiting %lld ms",
                 (long long)(g_next_wifi_reconnect_ms - now));
        return;
    }

    ESP_LOGI(TAG, "Attempting Wi-Fi reconnect. delay_ms=%d", g_wifi_reconnect_delay_ms);
    esp_err_t err = esp_wifi_connect();
    ESP_LOGI(TAG, "esp_wifi_connect returned: %s", esp_err_to_name(err));

    g_next_wifi_reconnect_ms = now + g_wifi_reconnect_delay_ms;
    g_wifi_reconnect_delay_ms *= 2;
    if (g_wifi_reconnect_delay_ms > WIFI_RECONNECT_MAX_MS) {
        g_wifi_reconnect_delay_ms = WIFI_RECONNECT_MAX_MS;
    }
}

static void wifi_event_handler(void *arg,
                               esp_event_base_t event_base,
                               int32_t event_id,
                               void *event_data)
{
    (void)arg;

    if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_START) {
        ESP_LOGI(TAG, "WIFI_EVENT_STA_START received. Connecting to SSID=%s password_len=%u",
                 WIFI_SSID,
                 (unsigned int)strlen(WIFI_PASSWORD));

        g_next_wifi_reconnect_ms = 0;
        g_wifi_reconnect_delay_ms = WIFI_RECONNECT_MIN_MS;
        schedule_wifi_reconnect();

    } else if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_CONNECTED) {
        wifi_event_sta_connected_t *connected =
            (wifi_event_sta_connected_t *)event_data;
        if (connected && connected->channel > 0) {
            g_saved_wifi_channel = connected->channel;
        }

    } else if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_DISCONNECTED) {
        wifi_event_sta_disconnected_t *disc = (wifi_event_sta_disconnected_t *)event_data;

        g_wifi_connected = false;
        g_last_transport_error = true;

        int reason = disc ? disc->reason : -1;

        ESP_LOGW(TAG,
                 "WIFI_EVENT_STA_DISCONNECTED. reason=%d SSID=%s password_len=%u",
                 reason,
                 WIFI_SSID,
                 (unsigned int)strlen(WIFI_PASSWORD));

        if (disc) {
            log_wifi_disconnect_reason(disc->reason);
        }

        set_status_text("Reconnecting Wi-Fi...", LV_COLOR_MAKE(0xE6, 0x51, 0x00));

        schedule_wifi_reconnect();

    } else if (event_base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *event = (ip_event_got_ip_t *)event_data;

        g_wifi_connected = true;
        g_last_transport_error = false;
        g_next_wifi_reconnect_ms = 0;
        g_wifi_reconnect_delay_ms = WIFI_RECONNECT_MIN_MS;

        ESP_LOGI(TAG,
                 "IP_EVENT_STA_GOT_IP. Wi-Fi connected. IP=" IPSTR " gateway=" IPSTR " netmask=" IPSTR,
                 IP2STR(&event->ip_info.ip),
                 IP2STR(&event->ip_info.gw),
                 IP2STR(&event->ip_info.netmask));

        set_status_text("Wi-Fi connected", LV_COLOR_MAKE(0x2E, 0x7D, 0x32));
        if (!g_timer_wakeup_boot) {
            wake_display_for_event();
        }

        /* Poll immediately instead of waiting out the current idle delay. */
        notify_pager_wake();
    }
}

static esp_err_t init_wifi(void)
{
    ESP_LOGI(TAG, "init_wifi starting");
    ESP_LOGI(TAG, "Wi-Fi SSID='%s'", WIFI_SSID);
    ESP_LOGI(TAG, "Wi-Fi password length=%u", (unsigned int)strlen(WIFI_PASSWORD));
    ESP_LOGI(TAG, "Pager API base URL=%s", API_BASE_URL);
    ESP_LOGI(TAG, "Pager responder=%s", PAGER_RESPONDER_NAME);
    ESP_LOGI(TAG, "Local machine filter='%s'",
             (PAGER_MACHINE_FILTER && PAGER_MACHINE_FILTER[0] != '\0')
                 ? PAGER_MACHINE_FILTER
                 : "ALL MACHINES");

    if (!WIFI_SSID || strlen(WIFI_SSID) == 0) {
        ESP_LOGE(TAG, "WIFI_SSID is empty");
        return ESP_FAIL;
    }

    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());

    esp_netif_t *sta_netif = esp_netif_create_default_wifi_sta();
    if (!sta_netif) {
        ESP_LOGE(TAG, "Failed to create default Wi-Fi STA netif");
        return ESP_FAIL;
    }

#if USE_STATIC_IP
    {
        esp_netif_ip_info_t ip_info = { 0 };
        ip4_addr_t parsed;

        if (!ip4addr_aton(STATIC_IP_ADDR, &parsed)) {
            ESP_LOGE(TAG, "Static IP address failed to parse: %s", STATIC_IP_ADDR);
            return ESP_FAIL;
        }
        ip_info.ip.addr = parsed.addr;

        if (!ip4addr_aton(STATIC_IP_GATEWAY, &parsed)) {
            ESP_LOGE(TAG, "Static IP gateway failed to parse: %s", STATIC_IP_GATEWAY);
            return ESP_FAIL;
        }
        ip_info.gw.addr = parsed.addr;

        if (!ip4addr_aton(STATIC_IP_NETMASK, &parsed)) {
            ESP_LOGE(TAG, "Static IP netmask failed to parse: %s", STATIC_IP_NETMASK);
            return ESP_FAIL;
        }
        ip_info.netmask.addr = parsed.addr;

        ESP_ERROR_CHECK(esp_netif_dhcpc_stop(sta_netif));
        ESP_ERROR_CHECK(esp_netif_set_ip_info(sta_netif, &ip_info));

        ESP_LOGI(TAG, "Static IP configured. IP=%s gateway=%s netmask=%s",
                 STATIC_IP_ADDR, STATIC_IP_GATEWAY, STATIC_IP_NETMASK);
    }
#endif

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));

    /* Runtime-only Wi-Fi configuration avoids unnecessary flash writes. */
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));

    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event_handler, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event_handler, NULL));

    wifi_config_t wifi_config = {0};

    snprintf((char *)wifi_config.sta.ssid,
             sizeof(wifi_config.sta.ssid),
             "%s",
             WIFI_SSID);

    snprintf((char *)wifi_config.sta.password,
             sizeof(wifi_config.sta.password),
             "%s",
             WIFI_PASSWORD);

    /* Keep auth threshold commented out while debugging mixed WPA/WPA2 plant networks. */
    // wifi_config.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;

    /* Measured in AP beacon intervals, and only used by WIFI_PS_MAX_MODEM.
     * Harmless under MIN_MODEM, so it is set here ready for either mode. */
    wifi_config.sta.listen_interval = WIFI_LISTEN_INTERVAL;
    wifi_config.sta.channel = 0;
    wifi_config.sta.pmf_cfg.capable = true;
    wifi_config.sta.pmf_cfg.required = false;

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(ESP_IF_WIFI_STA, &wifi_config));

    /*
     * Modem sleep is the largest safe battery win for this REST polling pager.
     * Every transaction is pager-initiated, so parking the receiver between
     * beacons cannot lose an alert; the 45 s poll still finds it.
     */
    ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_POWER_SAVE_MODE));
    ESP_LOGI(TAG, "Wi-Fi power save mode set (listen_interval=%d)", WIFI_LISTEN_INTERVAL);

    ESP_LOGI(TAG, "Starting Wi-Fi. Connection will happen from WIFI_EVENT_STA_START.");
    ESP_ERROR_CHECK(esp_wifi_start());

    return ESP_OK;
}

#if ENABLE_TCP_DIAGNOSTIC_PROBE
static bool tcp_connect_probe(const char *label, const char *ip, uint16_t port, int timeout_ms)
{
    ESP_LOGI(TAG, "----------------------------------------");
    ESP_LOGI(TAG, "TCP TEST: %s", label);
    ESP_LOGI(TAG, "Target: %s:%u timeout=%d ms", ip, (unsigned int)port, timeout_ms);

    int sock = socket(AF_INET, SOCK_STREAM, IPPROTO_IP);
    if (sock < 0) {
        ESP_LOGE(TAG, "%s: socket() failed errno=%d (%s)",
                 label, errno, strerror(errno));
        return false;
    }

    int flags = fcntl(sock, F_GETFL, 0);
    if (flags < 0) {
        ESP_LOGE(TAG, "%s: fcntl(F_GETFL) failed errno=%d (%s)",
                 label, errno, strerror(errno));
        close(sock);
        return false;
    }

    if (fcntl(sock, F_SETFL, flags | O_NONBLOCK) < 0) {
        ESP_LOGE(TAG, "%s: fcntl(F_SETFL) failed errno=%d (%s)",
                 label, errno, strerror(errno));
        close(sock);
        return false;
    }

    struct sockaddr_in dest = { 0 };
    dest.sin_family = AF_INET;
    dest.sin_port = htons(port);

    if (inet_pton(AF_INET, ip, &dest.sin_addr) != 1) {
        ESP_LOGE(TAG, "%s: inet_pton() failed for %s", label, ip);
        close(sock);
        return false;
    }

    int result = connect(sock, (struct sockaddr *)&dest, sizeof(dest));
    if (result == 0) {
        ESP_LOGI(TAG, "%s: CONNECT SUCCESS (immediate)", label);
        close(sock);
        return true;
    }

    if (errno != EINPROGRESS && errno != EWOULDBLOCK) {
        int saved_errno = errno;
        ESP_LOGE(TAG, "%s: CONNECT FAILED immediately errno=%d (%s)",
                 label, saved_errno, strerror(saved_errno));
        close(sock);
        return false;
    }

    fd_set write_fds;
    FD_ZERO(&write_fds);
    FD_SET(sock, &write_fds);

    struct timeval timeout;
    timeout.tv_sec = timeout_ms / 1000;
    timeout.tv_usec = (timeout_ms % 1000) * 1000;

    ESP_LOGI(TAG, "%s: connect in progress; waiting for TCP handshake...", label);

    result = select(sock + 1, NULL, &write_fds, NULL, &timeout);
    if (result == 0) {
        ESP_LOGE(TAG, "%s: CONNECT TIMEOUT after %d ms", label, timeout_ms);
        close(sock);
        return false;
    }

    if (result < 0) {
        int saved_errno = errno;
        ESP_LOGE(TAG, "%s: select() failed errno=%d (%s)",
                 label, saved_errno, strerror(saved_errno));
        close(sock);
        return false;
    }

    int socket_error = 0;
    socklen_t error_len = sizeof(socket_error);
    if (getsockopt(sock, SOL_SOCKET, SO_ERROR, &socket_error, &error_len) < 0) {
        int saved_errno = errno;
        ESP_LOGE(TAG, "%s: getsockopt(SO_ERROR) failed errno=%d (%s)",
                 label, saved_errno, strerror(saved_errno));
        close(sock);
        return false;
    }

    if (socket_error == 0) {
        ESP_LOGI(TAG, "%s: CONNECT SUCCESS", label);
        close(sock);
        return true;
    }

    ESP_LOGE(TAG, "%s: CONNECT FAILED socket_error=%d (%s)",
             label, socket_error, strerror(socket_error));
    close(sock);
    return false;
}
#endif /* ENABLE_TCP_DIAGNOSTIC_PROBE */

static void log_wifi_diagnostics(void)
{
    uint8_t mac[6] = { 0 };
    if (esp_wifi_get_mac(ESP_IF_WIFI_STA, mac) == ESP_OK) {
        ESP_LOGI(TAG, "Wi-Fi STA MAC=%02X:%02X:%02X:%02X:%02X:%02X",
                 mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    }

    wifi_ap_record_t ap = { 0 };
    if (esp_wifi_sta_get_ap_info(&ap) == ESP_OK) {
        ESP_LOGI(TAG,
                 "Connected AP: SSID='%s' BSSID=%02X:%02X:%02X:%02X:%02X:%02X channel=%u RSSI=%d",
                 (const char *)ap.ssid,
                 ap.bssid[0], ap.bssid[1], ap.bssid[2],
                 ap.bssid[3], ap.bssid[4], ap.bssid[5],
                 (unsigned int)ap.primary,
                 (int)ap.rssi);
    } else {
        ESP_LOGW(TAG, "Could not read current AP information");
    }
}

#if ENABLE_TCP_DIAGNOSTIC_PROBE
static void tcp_diagnostic_probe(void)
{
    const int timeout_ms = 10000;

    ESP_LOGI(TAG, "========================================");
    ESP_LOGI(TAG, "TCP DIAGNOSTIC TEST START");
    ESP_LOGI(TAG, "Each connection has a %d ms timeout", timeout_ms);

    log_wifi_diagnostics();

    /*
     * Test 1:
     * ProcessGuard through the DEV-APPS/local interface.
     *
     * Pager and 192.168.26.2 are on the same local network,
     * so this connection does not need to go through the gateway.
     */


    /*
     * Test 3:
     * Known external TCP destination.
     */
    bool cloudflare_ok = tcp_connect_probe(
        "Cloudflare HTTPS",
        "1.1.1.1",
        443,
        timeout_ms);

    /*
     * Test 4:
     * Another external TCP destination.
     */
    bool google_dns_ok = tcp_connect_probe(
        "Google DNS TCP",
        "8.8.8.8",
        53,
        timeout_ms);



    ESP_LOGI(TAG, "========================================");
    ESP_LOGI(TAG, "TCP DIAGNOSTIC SUMMARY");

    


    ESP_LOGI(
        TAG,
        "Cloudflare          1.1.1.1:443        : %s",
        cloudflare_ok ? "SUCCESS" : "FAILED");

    ESP_LOGI(
        TAG,
        "Google DNS          8.8.8.8:53         : %s",
        google_dns_ok ? "SUCCESS" : "FAILED");

    ESP_LOGI(TAG, "TCP DIAGNOSTIC TEST COMPLETE");
    ESP_LOGI(TAG, "========================================");
}
#endif /* ENABLE_TCP_DIAGNOSTIC_PROBE */

static void pager_task(void *arg)
{
    (void)arg;

    ESP_LOGI(TAG, "Pager task started");

    int64_t next_poll_ms = 0;
    int64_t last_waiting_wifi_log_ms = 0;
    bool net_diagnostics_done = false;

    while (1) {
        /*
         * Battery and charge sampling used to live here. It now runs in
         * power_monitor_task so it cannot be delayed by a blocking HTTP
         * transaction, a reconnect backoff, or the `continue` in the
         * disconnected path below.
         */

        if (!g_wifi_connected) {
            int64_t now = now_ms();

            /* Keep servicing the reconnect deadline even if the disconnect event
             * happened before the backoff timer expired. */
            if (now >= g_next_wifi_reconnect_ms) {
                schedule_wifi_reconnect();
            }

            if (now - last_waiting_wifi_log_ms >= 60000) {
                ESP_LOGW(TAG, "Pager task waiting for Wi-Fi. connected=%d transport_error=%d last_http_status=%d last_reason=%s",
                         g_wifi_connected ? 1 : 0,
                         g_last_transport_error ? 1 : 0,
                         g_last_http_status,
                         g_last_http_reason);
                last_waiting_wifi_log_ms = now;
            }

            process_vibration_state();
            render_alerts();
            update_display_power();
            int wait_ms = (g_display_brightness == 0 && g_vibration_until_ms == 0)
                              ? UI_SCREEN_OFF_TICK_MS
                              : UI_ACTIVE_TICK_MS;
            pager_wait_ms(wait_ms);
            continue;
        }

        if (!net_diagnostics_done) {
            net_diagnostics_done = true;
            log_wifi_diagnostics();
#if ENABLE_TCP_DIAGNOSTIC_PROBE
            tcp_diagnostic_probe();
#endif
        }

        process_action_queue();

        int64_t now = now_ms();

        if (now >= next_poll_ms && !g_action_in_flight) {
            ESP_LOGI(TAG, "Poll due. interval_ms=%d", current_poll_interval_ms());

            bool ok = fetch_alerts();

            if (!ok) {
                g_last_transport_error = true;
            }

            next_poll_ms = now_ms() + current_poll_interval_ms();
            ESP_LOGI(TAG, "Next poll in %d ms", current_poll_interval_ms());
        }

        process_open_reminder_vibration();
        process_vibration_state();
        render_alerts();
        update_display_power();
        maybe_deep_sleep_when_no_open();

        int wait_ms = (g_display_brightness == 0 && g_vibration_until_ms == 0)
                          ? UI_SCREEN_OFF_TICK_MS
                          : UI_ACTIVE_TICK_MS;

        /* Never oversleep the next poll. */
        int64_t until_poll_ms = next_poll_ms - now_ms();
        if (until_poll_ms > 0 && until_poll_ms < wait_ms) {
            wait_ms = (int)until_poll_ms;
        }

        pager_wait_ms(wait_ms);
    }
}

void app_main(void)
{
    g_timer_wakeup_boot =
        (esp_sleep_get_wakeup_cause() == ESP_SLEEP_WAKEUP_TIMER);

    /* Production logging: less UART/CPU activity while retaining warnings/errors. */
        esp_log_level_set("*", ESP_LOG_INFO);
    esp_log_level_set(TAG, ESP_LOG_INFO);

    ESP_LOGI(TAG, "========================================");
    ESP_LOGI(TAG, "ProcessGuard Pager booting");
    ESP_LOGI(TAG, "Compile date/time: %s %s", __DATE__, __TIME__);
    ESP_LOGI(TAG, "Configured SSID='%s' password_len=%u",
             WIFI_SSID,
             (unsigned int)strlen(WIFI_PASSWORD));
    ESP_LOGI(TAG, "Configured API_BASE_URL=%s", API_BASE_URL);
    ESP_LOGI(TAG, "========================================");

    Core2ForAWS_Init();

    g_display_power_mutex = xSemaphoreCreateMutex();
    if (!g_display_power_mutex) {
        ESP_LOGE(TAG, "Failed to create display power mutex");
        abort();
    }

    /* Wake signal for the pager task's idle wait. Created before the touch
     * task and the UI so no giver can run against a NULL handle. */
    g_wake_sem = xSemaphoreCreateBinary();
    if (!g_wake_sem) {
        ESP_LOGE(TAG, "Failed to create wake semaphore");
        abort();
    }

    /* Same, for the power monitor task. Must exist before build_ui(), which
     * can trigger a display wake. */
    g_battery_wake_sem = xSemaphoreCreateBinary();
    if (!g_battery_wake_sem) {
        ESP_LOGE(TAG, "Failed to create battery wake semaphore");
        abort();
    }

    /*
     * ADC1 enable mask (AXP192 REG82):
     *   bit7 battery voltage  - the percentage reading
     *   bit6 battery current  - required for the charge/discharge direction
     *                           flag in REG00 bit 2 to be meaningful
     *
     * The previous 0x80 saved a negligible amount of power and left charge
     * detection working off an unreliable bit. The remaining five channels
     * (ACIN/VBUS/APS/TS) stay disabled since nothing reads them.
     */
    Axp192_SetAdc1Enable(0xC0);

#if DISABLE_UNUSED_5V_EXPANSION
    Axp192_EnableExten(0);
#endif

    set_led_idle();
    Core2ForAWS_Motor_SetStrength(0);

    ESP_LOGI(TAG, "Initializing NVS");
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_LOGW(TAG, "NVS needs erase. err=%s", esp_err_to_name(err));
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);
    ESP_LOGI(TAG, "NVS initialized");

    init_power_management();

    ESP_LOGI(TAG, "Creating action queue");
    g_action_queue = xQueueCreate(2, sizeof(andon_alert_t));
    if (!g_action_queue) {
        ESP_LOGE(TAG, "Failed to create action queue");
        abort();
    }

    mark_user_activity_now();

    build_ui();
    set_status_text("Connecting Wi-Fi...", LV_COLOR_MAKE(0xE6, 0x51, 0x00));

    ESP_LOGI(TAG, "Calling init_wifi");
    ESP_ERROR_CHECK(init_wifi());

    ESP_LOGI(TAG, "Creating independent touch wake task");
    BaseType_t touch_task_result = xTaskCreatePinnedToCore(
        touch_wake_task, "touch_wake_task", 3072, NULL, 6, NULL, 1);
    if (touch_task_result != pdPASS) {
        ESP_LOGE(TAG, "Failed to create touch wake task");
        abort();
    }

    ESP_LOGI(TAG, "Creating power monitor task");
    BaseType_t power_task_result = xTaskCreatePinnedToCore(
        power_monitor_task, "power_monitor_task", 4096, NULL, 4, NULL, 1);
    if (power_task_result != pdPASS) {
        ESP_LOGE(TAG, "Failed to create power monitor task");
        abort();
    }

    ESP_LOGI(TAG, "Creating pager task with larger stack");
    BaseType_t task_result = xTaskCreatePinnedToCore(
        pager_task, "andon_pager_task", 24576, NULL, 5, NULL, 1);
    if (task_result != pdPASS) {
        ESP_LOGE(TAG, "Failed to create pager task");
        abort();
    }

    ESP_LOGI(TAG, "app_main complete");
}