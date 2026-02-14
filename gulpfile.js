var gulp = require('gulp');
var del = require('del');
var sass = require('gulp-dart-sass');
var prefix = require('gulp-autoprefixer');
var replace = require('gulp-replace');
var concat = require('gulp-concat');
var fs = require('fs');

gulp.task('clean', function(){
  return del([
    './.tmp',
    './dist'
  ]);
});

gulp.task('buildCSS', function(){
  return gulp.src('./app/**/*.scss')
      .pipe(sass({ outputStyle: 'compressed' }))
      .pipe(prefix("last 2 versions"))
      .pipe(concat('style.min.css'))
      .pipe(gulp.dest('./.tmp/app/base/css'));
});

gulp.task('buildContentScript', function(){
  // Escape CSS so it can be safely injected into a double-quoted JS string.
  var styleStr = fs.readFileSync('./.tmp/app/base/css/style.min.css','utf8')
    .replace(/\\/g,'\\\\')
    .replace(/"/g,'\\\"')
    .replace(/\r?\n/g,'\\n')
    .replace(/\u2028/g,'\\u2028')
    .replace(/\u2029/g,'\\u2029');

  return gulp.src('./content.js')
      .pipe(replace(/<!-- tid:(.+?) -->/i, styleStr))
      .pipe(gulp.dest('./dist/'));
});

gulp.task('build', gulp.series('buildCSS','buildContentScript', function(done){
  done();
}));

gulp.task('watchChanges',function(){
  gulp.watch('./app/**/*',gulp.series('build',function(done){
    done();
  }));
});

gulp.task('serve',gulp.series('clean','build','watchChanges', function(done){
  done();
}));
