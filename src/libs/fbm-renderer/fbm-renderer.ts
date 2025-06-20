import { BaseRenderer } from "@applemusic-like-lyrics/core";
import { GLProgram, createOffscreenCanvas, GLTexture } from "./GLProgram";
import { vec2 } from "gl-matrix";
import { vertexShader as mainVertexShader } from "./glsl/duplicate.vert";
import { fragmentShader as mainFragmentShader } from "./glsl/duplicate.frag";
import { fragmentShader as flowMapFragmentShader } from "./glsl/flowmap.frag";

export interface AppleBackgroundRenderOptions {
    rotationSpeed?: number;
    saturation?: number;
    blurLevel?: number;
}

export class FbmRenderer extends BaseRenderer {
    private gl: WebGL2RenderingContext;
	private frameTime = 0;
	private currentImageData?: ImageData;
	private lastTickTime = 0;
	private tickHandle = 0;
	private maxFPS = 60;
	private isPaused = false;
    private isStatic = false;
	private mainProgram: GLProgram;
    private flowMapProgram: GLProgram;
	private currentSize = vec2.fromValues(0, 0);
	private _disposed = false;
	private texture?: GLTexture;
	private flowMapTexture?: GLTexture;
    private flowMapFramebuffer?: WebGLFramebuffer;
	private positionBuffer?: WebGLBuffer;
	private texCoordBuffer?: WebGLBuffer;
	private indexBuffer?: WebGLBuffer;
	private isNoCover = true;
	private timeMultiplier = 0.4;
	private saturation = 1.0;
	private blurLevel = 6.0;
	private hasLyric = false;
	private renderScale = 0.5;

	setFlowSpeed(speed: number) {
		this.timeMultiplier = speed;
	}

	setSaturation(saturation: number) {
		this.saturation = Math.max(0, Math.min(1, saturation));
	}

	setBlur(level: number) {
		this.blurLevel = Math.max(0, level);
	}

	setRenderScale(scale: number) {
		this.renderScale = Math.max(0.1, Math.min(1, scale));
		this.updateFramebufferSize();
	}

	// This method is kept for API consistency but is no longer used by the metaball shader.
	setWarp(amount: number) { }

	private setImage(imageData: ImageData) {
		if (this.texture) {
			this.texture.dispose();
		}
		this.texture = new GLTexture(this.gl, imageData);

		const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, this.texture.tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.bindTexture(gl.TEXTURE_2D, null);

		this.currentImageData = imageData;
		this.isNoCover = false;
	}

	setFPS(fps: number) {
		this.maxFPS = fps;
	}

	pause() {
		this.isPaused = true;
	}

	resume() {
		this.isPaused = false;
	}

	constructor(canvas: HTMLCanvasElement, options: AppleBackgroundRenderOptions = {}) {
		super(canvas);
		const gl = canvas.getContext('webgl2');
		if (!gl) throw new Error("WebGL 2.0 not supported");
		this.gl = gl;
        
        if (!gl.getExtension('EXT_color_buffer_float')) {
            throw new Error("This browser does not support rendering to floating point textures (EXT_color_buffer_float), which is required for the performance optimization.");
        }

        this.saturation = options.saturation ?? this.saturation;
        this.blurLevel = options.blurLevel ?? this.blurLevel;
        this.timeMultiplier = options.rotationSpeed ?? this.timeMultiplier;

		this.mainProgram = new GLProgram(gl, mainVertexShader, mainFragmentShader, "main");
        this.flowMapProgram = new GLProgram(gl, mainVertexShader, flowMapFragmentShader, "flowmap");
		this.initBuffers();
        this.initFlowMapFramebuffer();
	}

	private initBuffers() {
		const gl = this.gl;
		this.positionBuffer = gl.createBuffer()!;
		gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);

		this.texCoordBuffer = gl.createBuffer()!;
		gl.bindBuffer(gl.ARRAY_BUFFER, this.texCoordBuffer);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), gl.STATIC_DRAW);

		this.indexBuffer = gl.createBuffer()!;
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
		gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
	}

    private initFlowMapFramebuffer() {
        const gl = this.gl;
        // Reduce resolution for better performance
        const width = Math.max(1, Math.floor(this.canvas.width * this.renderScale));
        const height = Math.max(1, Math.floor(this.canvas.height * this.renderScale));

        this.flowMapFramebuffer = gl.createFramebuffer()!;
        this.flowMapTexture = new GLTexture(gl, width, height, {
            internalFormat: gl.RGBA16F,
            format: gl.RGBA,
            type: gl.FLOAT
        });
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.flowMapFramebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.flowMapTexture.tex, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    private updateFramebufferSize() {
        if (this.currentSize[0] === this.canvas.width && this.currentSize[1] === this.canvas.height) return;
        
        this.currentSize = vec2.fromValues(this.canvas.width, this.canvas.height);
        // Reduce resolution for better performance
        const width = Math.max(1, Math.floor(this.canvas.width * this.renderScale));
        const height = Math.max(1, Math.floor(this.canvas.height * this.renderScale));
        
        if (this.flowMapTexture) {
            this.flowMapTexture.dispose();
        }
        this.flowMapTexture = new GLTexture(this.gl, width, height, {
            internalFormat: this.gl.RGBA16F,
            format: this.gl.RGBA,
            type: this.gl.FLOAT
        });
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.flowMapFramebuffer!);
        this.gl.framebufferTexture2D(this.gl.FRAMEBUFFER, this.gl.COLOR_ATTACHMENT0, this.gl.TEXTURE_2D, this.flowMapTexture.tex, 0);
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    }

	private render() {
		if (!this.texture || !this.currentImageData || !this.flowMapTexture) return;

		const gl = this.gl;
        this.updateFramebufferSize();

        // Pass 1: Render Flow Map
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.flowMapFramebuffer!);
        gl.viewport(0, 0, this.flowMapTexture.width, this.flowMapTexture.height);
        gl.clear(gl.COLOR_BUFFER_BIT);

        this.flowMapProgram.use();
        const finalTimeMultiplier = this.hasLyric ? this.timeMultiplier * 0.5 : this.timeMultiplier;
        this.flowMapProgram.setUniform1f("time", this.frameTime * finalTimeMultiplier);
        
        gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer!);
        gl.vertexAttribPointer(this.flowMapProgram.attrs["a_position"], 2, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(this.flowMapProgram.attrs["a_position"]);
        
        gl.bindBuffer(gl.ARRAY_BUFFER, this.texCoordBuffer!);
        gl.vertexAttribPointer(this.flowMapProgram.attrs["a_texCoord"], 2, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(this.flowMapProgram.attrs["a_texCoord"]);
        
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer!);
        gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);

        // Pass 2: Render Main Scene
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.clear(gl.COLOR_BUFFER_BIT);

        this.mainProgram.use();
        this.mainProgram.setUniform1f("time", this.frameTime * finalTimeMultiplier);
		this.mainProgram.setUniform1f("u_saturation", this.saturation);
		this.mainProgram.setUniform1f("u_blurLevel", this.blurLevel);

        gl.activeTexture(gl.TEXTURE0);
		this.texture?.bind();
        this.mainProgram.setUniform1i("u_texture", 0);
        
        gl.activeTexture(gl.TEXTURE1);
        this.flowMapTexture!.bind();
        this.mainProgram.setUniform1i("u_flowMap", 1);
        
        gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer!);
        gl.vertexAttribPointer(this.mainProgram.attrs["a_position"], 2, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(this.mainProgram.attrs["a_position"]);
        
        gl.bindBuffer(gl.ARRAY_BUFFER, this.texCoordBuffer!);
        gl.vertexAttribPointer(this.mainProgram.attrs["a_texCoord"], 2, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(this.mainProgram.attrs["a_texCoord"]);
        
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer!);
        gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
	}

	private tick = () => {
		if (this._disposed) return;
        if (this.isPaused || this.isStatic) {
            this.tickHandle = requestAnimationFrame(this.tick);
            return;
        }

		const now = performance.now();
		const delta = now - this.lastTickTime;
		this.lastTickTime = now;
        
        const frameInterval = 1000 / this.maxFPS;
        if (delta < frameInterval) {
            this.tickHandle = requestAnimationFrame(this.tick);
            return;
        }

        this.frameTime += delta / 1000;
        this.render();

		this.tickHandle = requestAnimationFrame(this.tick);
	};

	start() {
		if (this.isNoCover) return;
		this.lastTickTime = performance.now();
		this.tick();
	}

	dispose() {
		if (this._disposed) return;
		this._disposed = true;
		
		const gl = this.gl;
		if (this.tickHandle) cancelAnimationFrame(this.tickHandle);
		if (this.texture) this.texture.dispose();
        if (this.flowMapTexture) this.flowMapTexture.dispose();
        if (this.flowMapFramebuffer) gl.deleteFramebuffer(this.flowMapFramebuffer);
		this.mainProgram.dispose();
        this.flowMapProgram.dispose();
		if (this.positionBuffer) gl.deleteBuffer(this.positionBuffer);
		if (this.texCoordBuffer) gl.deleteBuffer(this.texCoordBuffer);
		if (this.indexBuffer) gl.deleteBuffer(this.indexBuffer);
	}

	async setAlbum(albumSource: string | HTMLImageElement | HTMLVideoElement, isVideo?: boolean) {
		let imageData: ImageData;
		
		if (typeof albumSource === "string") {
			const img = new Image();
			img.crossOrigin = "anonymous";
			await new Promise((resolve, reject) => {
				img.onload = resolve;
				img.onerror = reject;
				img.src = albumSource;
			});
			
			const canvas = document.createElement("canvas");
			canvas.width = img.width;
			canvas.height = img.height;
			const ctx = canvas.getContext("2d")!;
			ctx.drawImage(img, 0, 0);
			imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
		} else if (albumSource instanceof HTMLImageElement) {
			const canvas = document.createElement("canvas");
			canvas.width = albumSource.width;
			canvas.height = albumSource.height;
			const ctx = canvas.getContext("2d")!;
			ctx.drawImage(albumSource, 0, 0);
			imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
		} else {
			const canvas = document.createElement("canvas");	
			canvas.width = albumSource.videoWidth;
			canvas.height = albumSource.videoHeight;
			const ctx = canvas.getContext("2d")!;
			ctx.drawImage(albumSource, 0, 0);
			imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
		}
		
		this.setImage(imageData);
	}

	setLowFreqVolume(volume: number) {
		// This method is required by the base class.
        // It can be implemented to allow external control over the animation intensity
        // based on low-frequency audio input, similar to the internal dynamic flow.
	}

	setHasLyric(hasLyric: boolean) {
		this.hasLyric = hasLyric;
	}

	setVolume(volume: number) {
		this.setFlowSpeed(this.timeMultiplier * volume);
	}

	setStaticMode(staticMode: boolean) {
		this.isStatic = staticMode;
        if (staticMode) {
            // Render one final frame to show the static state
            this.render();
        }
	}
}
