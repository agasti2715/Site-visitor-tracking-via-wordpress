<?php
/**
 * Tables. Two of them, both narrow and indexed, so a visit costs two quick writes.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

function svt_table( $which ) {
	global $wpdb;
	return $wpdb->prefix . 'svt_' . $which;
}

function svt_install_tables() {
	global $wpdb;
	require_once ABSPATH . 'wp-admin/includes/upgrade.php';
	$charset = $wpdb->get_charset_collate();
	$visitors = svt_table( 'visitors' );
	$events   = svt_table( 'events' );

	dbDelta( "CREATE TABLE $visitors (
		id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
		visitor_key varchar(64) NOT NULL,
		name varchar(190) DEFAULT NULL,
		email varchar(190) DEFAULT NULL,
		company varchar(190) DEFAULT NULL,
		engaged tinyint(1) NOT NULL DEFAULT 0,
		first_seen datetime NOT NULL,
		last_seen datetime NOT NULL,
		updated_at datetime NOT NULL,
		PRIMARY KEY  (id),
		UNIQUE KEY visitor_key (visitor_key),
		KEY updated_at (updated_at)
	) $charset;" );

	dbDelta( "CREATE TABLE $events (
		id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
		visitor_id bigint(20) unsigned NOT NULL,
		session_key varchar(64) NOT NULL,
		url varchar(500) NOT NULL,
		path varchar(255) NOT NULL,
		title varchar(300) DEFAULT NULL,
		referrer varchar(500) DEFAULT NULL,
		ip varchar(45) DEFAULT NULL,
		user_agent varchar(255) DEFAULT NULL,
		created_at datetime NOT NULL,
		PRIMARY KEY  (id),
		KEY created_at (created_at),
		KEY visitor_id (visitor_id)
	) $charset;" );

	update_option( 'svt_db_version', SVT_VERSION );
}

/**
 * Daily tidy-up: forget raw IP addresses early, then drop old visits entirely.
 * Keeps the site's database small and the data footprint minimal.
 */
function svt_prune() {
	global $wpdb;
	$s        = svt_settings();
	$events   = svt_table( 'events' );
	$visitors = svt_table( 'visitors' );

	$ip_days = max( 1, (int) $s['ip_days'] );
	$wpdb->query( $wpdb->prepare(
		"UPDATE $events SET ip = NULL WHERE ip IS NOT NULL AND created_at < (UTC_TIMESTAMP() - INTERVAL %d DAY)",
		$ip_days
	) );

	$keep_days = max( 7, (int) $s['keep_days'] );
	$wpdb->query( $wpdb->prepare(
		"DELETE FROM $events WHERE created_at < (UTC_TIMESTAMP() - INTERVAL %d DAY) LIMIT 5000",
		$keep_days
	) );

	// Visitors with nothing left to show for them.
	$wpdb->query( "DELETE v FROM $visitors v LEFT JOIN $events e ON e.visitor_id = v.id WHERE e.id IS NULL" );
}
add_action( 'svt_daily_prune', 'svt_prune' );
