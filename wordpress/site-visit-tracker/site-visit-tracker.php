<?php
/**
 * Plugin Name:       Site Visit Tracker
 * Description:       Records who visits this site — their company, region and visit history — in this site's own database. No external requests, no page-speed cost.
 * Version:           1.0.4
 * Requires at least: 5.6
 * Requires PHP:      7.2
 * License:           GPL-2.0-or-later
 * Text Domain:       site-visit-tracker
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'SVT_VERSION', '1.0.4' );
define( 'SVT_FILE', __FILE__ );
define( 'SVT_OPTION', 'svt_settings' );
// The dashboard fills this in when you download the plugin, so connecting needs no typing.
define( 'SVT_BAKED_KEY', '__SVT_API_KEY__' );
// Optional: Apollo.io website-visitor tracker id, filled in for sites that use Apollo.
define( 'SVT_BAKED_APOLLO', '__SVT_APOLLO_ID__' );

require_once __DIR__ . '/includes/db.php';
require_once __DIR__ . '/includes/rest.php';
require_once __DIR__ . '/includes/admin.php';

function svt_defaults() {
	return array(
		'api_key'        => 0 === strpos( SVT_BAKED_KEY, '__' ) ? '' : SVT_BAKED_KEY,
		'identify_users' => 1,
		'identify_forms' => 1,
		'skip_team'      => 1,
		'respect_consent'=> 1,
		'keep_days'      => 180,
		'ip_days'        => 30,
		'apollo_app_id'  => svt_valid_apollo_id( SVT_BAKED_APOLLO ),
	);
}

// Apollo tracker ids are 24 hex characters; anything else (including the placeholder) means "off".
function svt_valid_apollo_id( $id ) {
	$id = strtolower( trim( (string) $id ) );
	return preg_match( '/^[a-f0-9]{24}$/', $id ) ? $id : '';
}

function svt_settings() {
	$saved = get_option( SVT_OPTION, array() );
	return wp_parse_args( is_array( $saved ) ? $saved : array(), svt_defaults() );
}

register_activation_hook( __FILE__, 'svt_activate' );
function svt_activate() {
	svt_install_tables();
	$settings = svt_settings();
	if ( empty( $settings['api_key'] ) ) {
		$settings['api_key'] = wp_generate_password( 40, false, false );
	}
	update_option( SVT_OPTION, $settings );
	if ( ! wp_next_scheduled( 'svt_daily_prune' ) ) {
		wp_schedule_event( time() + HOUR_IN_SECONDS, 'daily', 'svt_daily_prune' );
	}
}

register_deactivation_hook( __FILE__, function () {
	wp_clear_scheduled_hook( 'svt_daily_prune' );
} );

// Tables created before an update of this plugin get brought up to date.
add_action( 'plugins_loaded', function () {
	if ( get_option( 'svt_db_version' ) !== SVT_VERSION ) {
		svt_install_tables();
	}
} );

// Tell consent managers (Complianz, CookieYes…) that this plugin is consent-aware.
add_filter( 'wp_consent_api_registered_' . plugin_basename( __FILE__ ), '__return_true' );

// ─────────────────────────── Front end ───────────────────────────

// Late priority, so a consent manager has registered its script before we look for it.
add_action( 'wp_enqueue_scripts', 'svt_enqueue', 100 );
function svt_enqueue() {
	if ( is_admin() || is_feed() || is_robots() || is_trackback() ) {
		return;
	}
	$s = svt_settings();
	// Your own team browsing the site are not visitors.
	if ( ! empty( $s['skip_team'] ) && current_user_can( 'edit_posts' ) ) {
		return;
	}

	$deps = array();
	if ( ! empty( $s['respect_consent'] ) && function_exists( 'wp_has_consent' ) && wp_script_is( 'wp-consent-api', 'registered' ) ) {
		$deps[] = 'wp-consent-api';
	}

	// A small static file on this domain, loaded async in the footer: no render blocking,
	// no third-party DNS lookup, cached by the browser for a year.
	wp_enqueue_script( 'svt-tracker', plugins_url( 'assets/t.js', SVT_FILE ), $deps, SVT_VERSION, true );

	if ( ! empty( $s['identify_users'] ) && is_user_logged_in() ) {
		$user = wp_get_current_user();
		$name = trim( $user->first_name . ' ' . $user->last_name );
		$info = array_filter( array(
			'name'    => $name ? $name : $user->display_name,
			'email'   => $user->user_email,
			'company' => get_user_meta( $user->ID, 'billing_company', true ), // WooCommerce
		) );
		wp_add_inline_script(
			'svt-tracker',
			'window.svt=window.svt||[];window.svt.push(["identify",' . wp_json_encode( $info ) . ']);',
			'before'
		);
	}
}

// Perfmatters ignores the attributes above. Its documented filters (perfmatters.io/docs/filters)
// keep the tracker out of "Delay JavaScript" and "Minify JavaScript"; minifying would also move the
// file to a cache path where the delay exclusion no longer matches it.
function svt_perfmatters_exclude( $exclusions ) {
	$exclusions   = is_array( $exclusions ) ? $exclusions : array();
	$exclusions[] = 'site-visit-tracker/assets/t.js';
	$exclusions[] = 'svt-tracker';
	$exclusions[] = 'svt-apollo'; // the Apollo loader below: it already waits for an idle browser
	return $exclusions;
}
add_filter( 'perfmatters_delay_js_exclusions', 'svt_perfmatters_exclude' );
add_filter( 'perfmatters_minify_js_exclusions', 'svt_perfmatters_exclude' );

// Add async plus the settings the tracker reads, without an extra request.
add_filter( 'script_loader_tag', 'svt_script_tag', 10, 3 );
function svt_script_tag( $tag, $handle, $src ) {
	if ( 'svt-tracker' !== $handle ) {
		return $tag;
	}
	$s          = svt_settings();
	$attributes = ' async data-endpoint="' . esc_url( rest_url( 'svt/v1/c' ) ) . '"';
	$attributes .= ' data-site="wp"';
	if ( ! empty( $s['identify_forms'] ) ) {
		$attributes .= ' data-forms="true"';
	}
	if ( ! empty( $s['respect_consent'] ) && function_exists( 'wp_has_consent' ) ) {
		$attributes .= ' data-consent="wp"';
	}
	// Ask the common speed plugins to leave this one alone: it is already async and tiny,
	// and delaying it would lose visitors who read one page and leave.
	// (Cloudflare Rocket Loader, LiteSpeed, WP Rocket. Perfmatters is handled by its filters below.)
	$attributes .= ' data-cfasync="false" data-no-optimize="1" data-no-defer="1" data-no-minify="1"';

	return str_replace( ' src=', $attributes . ' src=', $tag );
}

// ─────────────────────────── Apollo.io (optional) ───────────────────────────
// Apollo names the companies behind visits. Its loader is Apollo's own snippet, but started
// only once the page has finished loading and the browser is idle, so it can never slow the
// page down or affect Core Web Vitals. With a consent manager present it also waits for the
// visitor to accept marketing cookies. Apollo identifies companies by IP address, so starting
// a second or two later loses next to nothing.

add_action( 'wp_footer', 'svt_print_apollo', 99 );
function svt_print_apollo() {
	if ( is_admin() || is_feed() || is_robots() || is_trackback() ) {
		return;
	}
	$s      = svt_settings();
	$app_id = svt_valid_apollo_id( $s['apollo_app_id'] );
	if ( ! $app_id ) {
		return;
	}
	if ( ! empty( $s['skip_team'] ) && current_user_can( 'edit_posts' ) ) {
		return;
	}
	$needs_consent = ! empty( $s['respect_consent'] ) && function_exists( 'wp_has_consent' );
	?>
<script id="svt-apollo-js" data-cfasync="false" data-no-optimize="1" data-no-defer="1" data-no-minify="1">
(function () {
	var appId = <?php echo wp_json_encode( $app_id ); ?>, needsConsent = <?php echo $needs_consent ? 'true' : 'false'; ?>, started = false;
	function allowed() {
		return !needsConsent || (typeof window.wp_has_consent === 'function' && window.wp_has_consent('marketing') === true);
	}
	function start() {
		if (started || !allowed()) return;
		started = true;
		var n = Math.random().toString(36).substring(7), o = document.createElement('script');
		o.src = 'https://assets.apollo.io/micro/website-tracker/tracker.iife.js?nocache=' + n;
		o.async = true; o.defer = true;
		o.onload = function () { window.trackingFunctions.onLoad({ appId: appId }); };
		document.head.appendChild(o);
	}
	function whenIdle() {
		if ('requestIdleCallback' in window) requestIdleCallback(start, { timeout: 3000 }); else setTimeout(start, 1);
	}
	if (document.readyState === 'complete') whenIdle(); else window.addEventListener('load', whenIdle);
	document.addEventListener('wp_listen_for_consent_change', start); // visitor clicks Accept
	setTimeout(start, 6000); // consent tools that load late
})();
</script>
	<?php
}
