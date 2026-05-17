export const BROW_HTML_APP_THEME_SKILL_ID = 'interaction-brow-html-app-theme';
export const BROW_HTML_APP_THEME_SKILL_NAME = 'Brow HTML App Theme';
export const BROW_HTML_APP_THEME_SKILL_SLUG = 'brow-html-app-theme';
export const BROW_HTML_APP_THEME_SKILL_DESCRIPTION = 'Create Brow-authored HTML apps as square-first purple mini experiences without redundant headings.';

export const BROW_HTML_APP_THEME_SHORT_GUIDANCE = 'Build HTML App Artifacts square-first for Brow: aim for a roughly 1:1 viewport, keep the user-requested artifact as the hero, skip decorative page headings unless requested, use Brow\'s charcoal + neon-purple theme, keep the whole experience inside the viewport without remote assets, and optionally use Brow\'s built-in spritesheet at "icons/brow-spritesheet.png" for games or character animation. For DOM sprites use CSS backgrounds; for canvas games load the image and render actual frames with drawImage instead of placeholder boxes.';

export const BROW_HTML_APP_THEME_MARKDOWN = `# Brow HTML App Theme

- Build a single self-contained HTML document with inline CSS and inline JavaScript only.
- Design square-first. The default Brow preview is compact, so target an approximately 1:1 viewport and keep the main experience centered.
- Do not add a decorative page title, hero heading, or repeated prompt text unless the user explicitly asked for one. Spend the space on the requested artifact itself.
- Match Brow visuals: charcoal or black surfaces, neon purple accents, cool gray text, crisp borders, subtle glow, and compact controls.
- Keep the layout responsive and contained: no horizontal overflow, no clipped controls, and avoid body scrollbars when possible.
- Do not rely on remote fonts, scripts, styles, images, frames, or network fetches.
- If the artifact would benefit from a built-in Brow character, game sprite, or animated mascot, you may use Brow's bundled spritesheet at "icons/brow-spritesheet.png". In a sandboxed HTML App Artifact, that relative path resolves against Brow's extension host, so it is allowed even though remote assets are not.
- The Brow spritesheet layout is 12 columns by 6 rows. Each source cell inside the PNG is 256x256 pixels. Typical rows: row 0 idle, row 1 jump or landing, row 2 run, row 3 pointing, row 4 walk down, row 5 walk up.
- Treat row 1 as an action row, not a generic loop. Use it when Brow leaves the ground, is airborne, or has just touched down.
- A good default split for row 1 is: earlier frames for takeoff and upward motion, middle or later frames for falling, and the last few frames for landing recovery. If the artwork reads differently, follow the visual motion of the sheet rather than forcing this split.
- Separate source size from display size when you implement the sprite. The crop rectangle inside the spritesheet stays 256x256, while the on-screen size can be scaled down to 96px, 64px, or any other size that fits the artifact.
- If the artifact is a canvas-based game or renders Brow inside a canvas, use the actual spritesheet frames in the canvas with an Image plus ctx.drawImage(...). Do not stop at defining a CSS sprite class if the visible character is painted in canvas.
- If Brow is the featured character in a game, do not replace the sprite with abstract purple rectangles or fallback boxes once the spritesheet is available.
- CSS usage example for the Brow spritesheet:

~~~css
:root {
	--brow-source-cell-size: 256;
	--brow-display-size: 96px;
}

.brow-sprite {
	width: var(--brow-display-size);
	height: var(--brow-display-size);
	background-image: url("icons/brow-spritesheet.png");
	background-repeat: no-repeat;
	background-size: calc(var(--brow-display-size) * 12) calc(var(--brow-display-size) * 6);
	image-rendering: pixelated;
}

.brow-sprite--idle {
	animation: brow-idle 900ms steps(12) infinite;
}

@keyframes brow-idle {
	from { background-position: 0 0; }
	to { background-position: calc(var(--brow-display-size) * -12) 0; }
}
~~~

- In CSS, the element width and background-size define the displayed frame size. The 256x256 source cell is not copied into CSS as "256px"; it is the source layout you are sampling from and scaling down for display.

- Canvas usage example for the Brow spritesheet:

~~~js
const browImage = new Image();
browImage.src = "icons/brow-spritesheet.png";

const BROW_FRAME_SIZE = 256;

function drawBrowFrame(ctx, frame, row, dx, dy, size, facingRight = true) {
	const sx = frame * BROW_FRAME_SIZE;
	const sy = row * BROW_FRAME_SIZE;

	ctx.save();
	ctx.translate(dx + size / 2, dy + size / 2);
	if (!facingRight) {
		ctx.scale(-1, 1);
	}
	ctx.drawImage(
		browImage,
		sx,
		sy,
		BROW_FRAME_SIZE,
		BROW_FRAME_SIZE,
		-size / 2,
		-size / 2,
		size,
		size,
	);
	ctx.restore();
}
~~~

- In canvas, the source rectangle values sx, sy, sw, and sh should use the 256x256 source cells, while the destination width and height control the visible scaled size on screen.
- Jump and landing example for a platformer:

~~~js
const BROW_ROWS = {
	idle: 0,
	jumpLanding: 1,
	run: 2,
};

function getBrowPose(player, tick) {
	if (!player.isGrounded) {
		if (player.vy < -1) {
			return { row: BROW_ROWS.jumpLanding, frame: 2 + (tick % 3) };
		}
		return { row: BROW_ROWS.jumpLanding, frame: 7 + (tick % 3) };
	}

	if (player.landingTimer > 0) {
		return { row: BROW_ROWS.jumpLanding, frame: 9 + Math.min(2, Math.floor((6 - player.landingTimer) / 2)) };
	}

	if (Math.abs(player.vx) > 0.5) {
		return { row: BROW_ROWS.run, frame: tick % 12 };
	}

	return { row: BROW_ROWS.idle, frame: Math.floor(tick / 6) % 12 };
}

function updateLandingTimer(player, wasGroundedLastFrame) {
	if (!wasGroundedLastFrame && player.isGrounded) {
		player.landingTimer = 6;
	} else if (player.landingTimer > 0) {
		player.landingTimer -= 1;
	}
}
~~~

- In that example, upward movement uses row 1 early frames, falling uses row 1 later frames, and landing keeps Brow on the last landing frames for a brief recovery beat before returning to run or idle.

- If you use the Brow spritesheet, keep the rest of the artifact self-contained and do not fetch any extra remote art assets just to support the animation.`;

export const BROW_HTML_APP_PROMPT_GUIDANCE = `When you create an HTML App Artifact, follow the built-in Interaction Skill "${BROW_HTML_APP_THEME_SKILL_NAME}": target a square-first viewport, avoid redundant headings unless requested, make the user's requested artifact the main focus, style it with Brow's purple-on-charcoal look, and if a game or animated UI would benefit from it you may use Brow's built-in spritesheet at "icons/brow-spritesheet.png". For DOM sprites use CSS sprite animation; for canvas-based games load the image and render visible Brow frames with drawImage instead of placeholder rectangles. If Brow jumps, use row 1 intentionally for ascent, descent, and a short landing recovery instead of looping a single generic airborne frame.`;