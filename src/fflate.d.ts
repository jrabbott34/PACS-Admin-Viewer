// fflate's package.json "exports" map doesn't resolve under our bundler moduleResolution
// even though it ships types; a plain ambient declaration sidesteps that mismatch.
declare module 'fflate';
