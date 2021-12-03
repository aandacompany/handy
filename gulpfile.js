'use strict';

const gulp = require('gulp')
, babelify = require('babelify')
, browserify = require('browserify')
, source = require('vinyl-source-stream')
, buffer = require('vinyl-buffer')
, uglify = require('gulp-uglify')
, streamify = require('gulp-streamify')
, concat = require('gulp-concat')
, cleanCSS = require('gulp-clean-css')
, less = require('gulp-less')
;

// concatenate handy_build.css and bootstrap.css
gulp.task('build-handy-styles', ()=>{
  return gulp.src(['./build/css/bootstrap.min.css', './build/css/handy_build.css'])
  .pipe(concat('handy.min.css'))
  .pipe(cleanCSS({compatibility: '*'}))
  .pipe(gulp.dest('./public/css'))
})

// make handy.js browser compatible
gulp.task('build-handy_scripts', ()=>{
  return browserify({
    entries: './build/js/handy_build.js',
    debug: true
  })
  .transform(babelify.configure({
      presets: [
        ["@babel/preset-env", {
            "targets": {
              "browsers": ["last 2 versions"]
            },
            useBuiltIns: 'entry',
            corejs: 3
          }
        ]
      ],
      plugins: [
        ["@babel/plugin-transform-runtime", {
              "regenerator": true
            }
        ]
      ]
    })
  )
  .bundle()
  .pipe(source('handy_scripts.min.js'))
  .pipe(buffer())
  .pipe(uglify())
  .pipe(gulp.src(['./build/js/jquery.min.js', './build/js/bootstrap.bundle.min.js'], {sourcemaps: true}))
  .pipe(concat('handy.min.js'))
  .pipe(gulp.dest('./public/js'))
})

// make handy configuration script browser compatible
gulp.task('build-handy_config_scripts', ()=>{
  return browserify({
    entries: './build/js/handy_config_build.js',
    debug: true
  })
  .transform(babelify.configure({
      presets: [
        ["@babel/preset-env", {
            "targets": {
              "browsers": ["last 2 versions"]
            },
            useBuiltIns: 'entry',
            corejs: 3
          }
        ]
      ],
      plugins: [
        ["@babel/plugin-transform-runtime", {
              "regenerator": true
            }
        ]
      ]
    })
  )
  .bundle()
  .pipe(source('handy_config.min.js'))
  .pipe(buffer())
  .pipe(uglify())
  .pipe(gulp.dest('./public/js'))
})

// set watch tasks
gulp.task('watch', ()=>{
  gulp.watch('build/css/*.css', gulp.parallel('build-handy-styles'));
  gulp.watch('build/js/*.js', gulp.parallel('build-handy_scripts', 'build-handy_config_scripts'));
});

// set startup tasks
gulp.task('default', gulp.parallel('build-handy-styles', 'build-handy_scripts', 
  'build-handy_config_scripts', 'watch'));
