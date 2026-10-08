<?php
/**
 * Settings screen: connection details for the dashboard, plus the few options.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

add_action( 'admin_menu', function () {
	add_options_page( 'Site Visit Tracker', 'Site Visit Tracker', 'manage_options', 'site-visit-tracker', 'svt_render_settings' );
} );

add_filter( 'plugin_action_links_' . plugin_basename( SVT_FILE ), function ( $links ) {
	array_unshift( $links, '<a href="' . esc_url( admin_url( 'options-general.php?page=site-visit-tracker' ) ) . '">Settings</a>' );
	return $links;
} );

add_action( 'admin_init', function () {
	register_setting( 'svt', SVT_OPTION, array( 'sanitize_callback' => 'svt_sanitize' ) );
} );

function svt_sanitize( $in ) {
	$in  = is_array( $in ) ? $in : array();
	$out = svt_settings();
	foreach ( array( 'identify_users', 'identify_forms', 'skip_team', 'respect_consent' ) as $key ) {
		$out[ $key ] = empty( $in[ $key ] ) ? 0 : 1;
	}
	$out['keep_days'] = min( 3650, max( 7, (int) ( isset( $in['keep_days'] ) ? $in['keep_days'] : 180 ) ) );
	$out['ip_days']   = min( (int) $out['keep_days'], max( 1, (int) ( isset( $in['ip_days'] ) ? $in['ip_days'] : 30 ) ) );
	if ( ! empty( $in['regenerate_key'] ) ) {
		$out['api_key'] = wp_generate_password( 40, false, false );
	}
	return $out;
}

function svt_render_settings() {
	if ( ! current_user_can( 'manage_options' ) ) {
		return;
	}
	global $wpdb;
	$s       = svt_settings();
	$name    = SVT_OPTION;
	$events  = (int) $wpdb->get_var( 'SELECT COUNT(*) FROM ' . svt_table( 'events' ) );
	$people  = (int) $wpdb->get_var( 'SELECT COUNT(*) FROM ' . svt_table( 'visitors' ) . ' WHERE name IS NOT NULL OR email IS NOT NULL' );
	$latest  = $wpdb->get_var( 'SELECT MAX(created_at) FROM ' . svt_table( 'events' ) );
	?>
	<div class="wrap">
		<h1>Site Visit Tracker</h1>

		<div class="notice notice-<?php echo $events ? 'success' : 'warning'; ?> inline"><p>
			<?php if ( $events ) : ?>
				<strong>Recording visits.</strong>
				<?php echo esc_html( number_format_i18n( $events ) ); ?> page views stored,
				<?php echo esc_html( number_format_i18n( $people ) ); ?> visitors identified by name.
				Last visit: <?php echo esc_html( $latest ? $latest . ' UTC' : 'none yet' ); ?>.
			<?php else : ?>
				<strong>No visits recorded yet.</strong> Open the site in a private window (logged-out) and reload this page.
			<?php endif; ?>
		</p></div>

		<h2>Connect your dashboard</h2>
		<p>Paste these two into the Site Visit Tracker dashboard to pull this site's visits into it.</p>
		<table class="form-table" role="presentation">
			<tr>
				<th scope="row">Site address</th>
				<td><code><?php echo esc_html( home_url() ); ?></code></td>
			</tr>
			<tr>
				<th scope="row">Site key</th>
				<td>
					<code id="svt-key"><?php echo esc_html( $s['api_key'] ); ?></code>
					<button type="button" class="button" onclick="navigator.clipboard.writeText(document.getElementById('svt-key').textContent);this.textContent='Copied';">Copy</button>
					<p class="description">Anyone with this key can read this site's visitor data. Keep it private.</p>
				</td>
			</tr>
		</table>

		<form method="post" action="options.php">
			<?php settings_fields( 'svt' ); ?>
			<h2>Options</h2>
			<table class="form-table" role="presentation">
				<tr>
					<th scope="row">Names</th>
					<td>
						<label><input type="checkbox" name="<?php echo esc_attr( $name ); ?>[identify_users]" value="1" <?php checked( $s['identify_users'] ); ?>>
							Record the name and email of logged-in users (and WooCommerce customers' company)</label><br>
						<label><input type="checkbox" name="<?php echo esc_attr( $name ); ?>[identify_forms]" value="1" <?php checked( $s['identify_forms'] ); ?>>
							Recognise visitors who fill in a form — only name, email and company fields are read</label>
					</td>
				</tr>
				<tr>
					<th scope="row">Your team</th>
					<td><label><input type="checkbox" name="<?php echo esc_attr( $name ); ?>[skip_team]" value="1" <?php checked( $s['skip_team'] ); ?>>
						Don't record visits from logged-in authors, editors and admins</label></td>
				</tr>
				<tr>
					<th scope="row">Consent</th>
					<td>
						<label><input type="checkbox" name="<?php echo esc_attr( $name ); ?>[respect_consent]" value="1" <?php checked( $s['respect_consent'] ); ?>>
							Only track after the visitor accepts statistics cookies</label>
						<p class="description">
							<?php if ( function_exists( 'wp_has_consent' ) ) : ?>
								A consent manager supporting the WordPress Consent API was found, so this is honoured.
							<?php else : ?>
								No consent manager with WordPress Consent API support was found. In Complianz, turn on
								<em>Integrations → WordPress Consent API</em>; otherwise this setting does nothing.
							<?php endif; ?>
							Required for visitors in the UK and EU.
						</p>
					</td>
				</tr>
				<tr>
					<th scope="row">Keep data for</th>
					<td>
						<input type="number" min="7" max="3650" name="<?php echo esc_attr( $name ); ?>[keep_days]" value="<?php echo esc_attr( $s['keep_days'] ); ?>" class="small-text"> days of visits,
						and <input type="number" min="1" max="3650" name="<?php echo esc_attr( $name ); ?>[ip_days]" value="<?php echo esc_attr( $s['ip_days'] ); ?>" class="small-text"> days for IP addresses.
						<p class="description">Older rows are deleted automatically each day, which keeps the database small.</p>
					</td>
				</tr>
				<tr>
					<th scope="row">Site key</th>
					<td><label><input type="checkbox" name="<?php echo esc_attr( $name ); ?>[regenerate_key]" value="1">
						Generate a new key on save (the dashboard will need the new one)</label></td>
				</tr>
			</table>
			<?php submit_button(); ?>
		</form>

		<p class="description">
			Visits are stored only in this site's own database. Nothing is sent to any other company.
			Because IP addresses and, where enabled, names are personal data, mention this tracking in your privacy policy.
		</p>
	</div>
	<?php
}
