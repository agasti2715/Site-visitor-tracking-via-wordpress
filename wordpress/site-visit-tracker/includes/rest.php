<?php
/**
 * The collector and the export the dashboard reads from.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

add_action( 'rest_api_init', function () {
	register_rest_route( 'svt/v1', '/c', array(
		'methods'             => 'POST',
		'callback'            => 'svt_rest_collect',
		'permission_callback' => '__return_true',
	) );
	register_rest_route( 'svt/v1', '/export', array(
		'methods'             => 'GET',
		'callback'            => 'svt_rest_export',
		'permission_callback' => 'svt_rest_key_ok',
	) );
	register_rest_route( 'svt/v1', '/ping', array(
		'methods'             => 'GET',
		'callback'            => 'svt_rest_ping',
		'permission_callback' => 'svt_rest_key_ok',
	) );
} );

function svt_rest_key_ok( WP_REST_Request $request ) {
	$sent  = (string) $request->get_header( 'x-svt-key' );
	$known = (string) svt_settings()['api_key'];
	if ( ! $known || ! $sent || ! hash_equals( $known, $sent ) ) {
		return new WP_Error( 'svt_forbidden', 'Wrong or missing site key.', array( 'status' => 403 ) );
	}
	return true;
}

function svt_clip( $value, $length ) {
	if ( ! is_string( $value ) ) {
		return null;
	}
	$value = trim( wp_strip_all_tags( $value ) );
	return $value === '' ? null : mb_substr( $value, 0, $length );
}

// Behind Sucuri / Cloudflare the real visitor IP arrives in a header.
function svt_visitor_ip() {
	foreach ( array( 'HTTP_X_SUCURI_CLIENTIP', 'HTTP_CF_CONNECTING_IP', 'HTTP_X_FORWARDED_FOR', 'REMOTE_ADDR' ) as $key ) {
		if ( empty( $_SERVER[ $key ] ) ) {
			continue;
		}
		$value = explode( ',', wp_unslash( $_SERVER[ $key ] ) )[0];
		$ip    = filter_var( trim( $value ), FILTER_VALIDATE_IP );
		if ( $ip ) {
			return $ip;
		}
	}
	return null;
}

function svt_is_bot( $ua ) {
	return ! $ua || preg_match( '/bot|crawl|spider|slurp|facebookexternalhit|embedly|preview|headless|lighthouse|pingdom|uptime|monitor|curl|wget|python-requests|axios|go-http|java\/|httpclient|phantomjs|puppeteer|playwright|selenium/i', $ua );
}

function svt_rest_collect( WP_REST_Request $request ) {
	// The browser fired this with sendBeacon and is not waiting for an answer.
	$body = json_decode( $request->get_body(), true );
	if ( ! is_array( $body ) ) {
		return new WP_REST_Response( null, 204 );
	}

	$visitor_key = svt_clip( isset( $body['vid'] ) ? $body['vid'] : '', 64 );
	$visitor_key = $visitor_key ? preg_replace( '/[^A-Za-z0-9_-]/', '', $visitor_key ) : '';
	$ua          = isset( $_SERVER['HTTP_USER_AGENT'] ) ? sanitize_text_field( wp_unslash( $_SERVER['HTTP_USER_AGENT'] ) ) : '';
	if ( ! $visitor_key || svt_is_bot( $ua ) ) {
		return new WP_REST_Response( null, 204 );
	}

	global $wpdb;
	$visitors = svt_table( 'visitors' );
	$now      = current_time( 'mysql', true );

	// One query: create the visitor, or touch the existing one and hand back its id.
	$wpdb->query( $wpdb->prepare(
		"INSERT INTO $visitors (visitor_key, first_seen, last_seen, updated_at) VALUES (%s, %s, %s, %s)
		 ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id), last_seen = VALUES(last_seen)",
		$visitor_key, $now, $now, $now
	) );
	$visitor_id = (int) $wpdb->insert_id;
	if ( ! $visitor_id ) {
		return new WP_REST_Response( null, 204 );
	}

	// The visitor moved the mouse, tapped or typed: a person, not a scanner. Sent once per browser.
	if ( isset( $body['type'] ) && 'engage' === $body['type'] ) {
		$wpdb->query( $wpdb->prepare(
			"UPDATE $visitors SET engaged = 1, updated_at = %s WHERE id = %d AND engaged = 0",
			$now, $visitor_id
		) );
		return new WP_REST_Response( null, 204 );
	}

	if ( isset( $body['type'] ) && 'identify' === $body['type'] ) {
		$fields = array();
		foreach ( array( 'name', 'email', 'company' ) as $field ) {
			$value = svt_clip( isset( $body[ $field ] ) ? $body[ $field ] : null, 190 );
			if ( $value ) {
				$fields[ $field ] = 'email' === $field ? sanitize_email( $value ) : $value;
			}
		}
		if ( $fields ) {
			$fields['updated_at'] = $now;
			$wpdb->update( $visitors, $fields, array( 'id' => $visitor_id ) );
		}
		return new WP_REST_Response( null, 204 );
	}

	$url = svt_clip( isset( $body['url'] ) ? $body['url'] : '', 500 );
	if ( ! $url ) {
		return new WP_REST_Response( null, 204 );
	}
	$path     = wp_parse_url( $url, PHP_URL_PATH );
	$referrer = svt_clip( isset( $body['ref'] ) ? $body['ref'] : '', 500 );

	$wpdb->insert( svt_table( 'events' ), array(
		'visitor_id'  => $visitor_id,
		'session_key' => svt_clip( isset( $body['sid'] ) ? $body['sid'] : '', 64 ) ?: 'none',
		'url'         => $url,
		'path'        => $path ? mb_substr( $path, 0, 255 ) : '/',
		'title'       => svt_clip( isset( $body['title'] ) ? $body['title'] : '', 300 ),
		'referrer'    => $referrer && 0 === strpos( $referrer, 'http' ) ? $referrer : null,
		'ip'          => svt_visitor_ip(),
		'user_agent'  => mb_substr( $ua, 0, 255 ),
		'created_at'  => $now,
	) );

	return new WP_REST_Response( null, 204 );
}

/**
 * Everything new since the dashboard last asked.
 */
function svt_rest_export( WP_REST_Request $request ) {
	global $wpdb;
	$events   = svt_table( 'events' );
	$visitors = svt_table( 'visitors' );

	$since_id   = max( 0, (int) $request->get_param( 'since_id' ) );
	$since_time = $request->get_param( 'since_time' );
	$since_time = $since_time && preg_match( '/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/', $since_time )
		? str_replace( 'T', ' ', $since_time ) : '1970-01-01 00:00:00';
	$limit      = min( 1000, max( 1, (int) $request->get_param( 'limit' ) ?: 500 ) );

	$rows = $wpdb->get_results( $wpdb->prepare(
		"SELECT e.id, e.visitor_id, e.session_key, e.url, e.path, e.title, e.referrer, e.ip, e.user_agent, e.created_at,
		        v.visitor_key, v.name, v.email, v.company, v.engaged, v.first_seen, v.last_seen
		 FROM $events e JOIN $visitors v ON v.id = e.visitor_id
		 WHERE e.id > %d ORDER BY e.id ASC LIMIT %d",
		$since_id, $limit
	), ARRAY_A );

	// Names and the "a person interacted" flag can arrive after the page view was already
	// exported, so send recently changed people too.
	$people = $wpdb->get_results( $wpdb->prepare(
		"SELECT visitor_key, name, email, company, engaged, first_seen, last_seen, updated_at
		 FROM $visitors WHERE updated_at > %s
		   AND (name IS NOT NULL OR email IS NOT NULL OR company IS NOT NULL OR engaged = 1)
		 ORDER BY updated_at ASC LIMIT %d",
		$since_time, $limit
	), ARRAY_A );

	return new WP_REST_Response( array(
		'site'       => array( 'name' => get_bloginfo( 'name' ), 'url' => home_url() ),
		'events'     => $rows,
		'identities' => $people,
		'cursor'     => array(
			'since_id'   => $rows ? (int) end( $rows )['id'] : $since_id,
			'since_time' => $people ? end( $people )['updated_at'] : $since_time,
		),
		'more'       => count( $rows ) >= $limit,
	) );
}

function svt_rest_ping() {
	global $wpdb;
	return new WP_REST_Response( array(
		'ok'      => true,
		'site'    => array( 'name' => get_bloginfo( 'name' ), 'url' => home_url() ),
		'version' => SVT_VERSION,
		'events'  => (int) $wpdb->get_var( 'SELECT COUNT(*) FROM ' . svt_table( 'events' ) ),
	) );
}
