(() => {
  const avatarTrigger = document.getElementById("epAvatarTrigger");
  const avatarInput = document.getElementById("epAvatarFile");
  const avatarPreview = document.getElementById("epAvatarPreview");
  const openProfileModalBtn = document.getElementById("openPremiumProfileModal");
  const profileOverlay = document.getElementById("profileModalOverlay");
  const profileClose = document.getElementById("profileModalClose");
  const profileBtn = document.getElementById("profileBtn");
  const mobileAuthBtn = document.getElementById("mobileAuthBtn");
  const profileDropHead = document.getElementById("profileDrop")?.querySelector(".profile-drop-head");
  const isTouchDevice =
    window.matchMedia("(hover: none), (pointer: coarse)").matches ||
    "ontouchstart" in window ||
    navigator.maxTouchPoints > 0;

  window.mobileProfileToggle = function (e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }

    window.__scLastProfileTouchEnd = Date.now();

    const user = typeof window.getCurrentUser === "function" ? window.getCurrentUser() : null;
    if (!user) {
      if (typeof window.openAuth === "function") window.openAuth();
      return false;
    }

    // If dropdown is visible, close it before opening edit profile.
    const drop = document.getElementById("profileDrop");
    if (drop && drop.classList.contains("open") && typeof window.closeProfileDrop === "function") {
      window.closeProfileDrop();
    }

    // Open profile editor directly (avatar/nickname tap should go here).
    if (typeof window.openEditProfile === "function") {
      window.openEditProfile();
    } else if (typeof window.openAuth === "function") {
      // Fallback if edit handler is unavailable
      window.openAuth("edit");
    }

    return false;
  };

  if (!avatarInput) return;

  let lastTouchTs = 0;

  function safeOpenPicker(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    avatarInput.click();
  }

  function onTouchStart(event) {
    lastTouchTs = Date.now();
    safeOpenPicker(event);
  }

  function onClick(event) {
    // Prevent duplicate picker opening right after touchstart.
    if (Date.now() - lastTouchTs < 450) return;
    safeOpenPicker(event);
  }

  if (avatarTrigger) {
    avatarTrigger.addEventListener("touchstart", onTouchStart, { passive: false });
    avatarTrigger.addEventListener("click", onClick, { passive: false });
  }

  // Optional extra target: tapping preview avatar also opens picker.
  if (avatarPreview) {
    avatarPreview.style.cursor = "pointer";
    avatarPreview.addEventListener("touchstart", onTouchStart, { passive: false });
    avatarPreview.addEventListener("click", onClick, { passive: false });
  }

  function openProfileModal() {
    if (!profileOverlay) return;
    profileOverlay.classList.add("open");
    profileOverlay.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
  }

  function closeProfileModal() {
    if (!profileOverlay) return;
    profileOverlay.classList.remove("open");
    profileOverlay.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
  }

  if (openProfileModalBtn) {
    openProfileModalBtn.addEventListener("click", openProfileModal);
    openProfileModalBtn.addEventListener("touchstart", (e) => {
      e.preventDefault();
      openProfileModal();
    }, { passive: false });
  }

  if (profileClose) profileClose.addEventListener("click", closeProfileModal);

  if (profileOverlay) {
    profileOverlay.addEventListener("click", (e) => {
      if (e.target === profileOverlay) closeProfileModal();
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeProfileModal();
  });

  function openProfileEntryPoint(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (typeof window.getCurrentUser === "function" && window.getCurrentUser()) {
      if (typeof window.toggleProfileDrop === "function") window.toggleProfileDrop();
    } else if (typeof window.openAuth === "function") {
      window.openAuth();
    }
  }

  function bindTouchAndClick(el, handler) {
    if (!el) return;
    let touched = false;

    if (isTouchDevice) {
      el.addEventListener(
        "touchend",
        (e) => {
          touched = true;
          window.__scLastProfileTouchEnd = Date.now();
          handler(e);
          setTimeout(() => {
            touched = false;
          }, 420);
        },
        { passive: false }
      );
    }

    el.addEventListener(
      "click",
      (e) => {
        if (touched) return;
        handler(e);
      },
      { passive: false }
    );
  }

  // The main mobile profile triggers are handled inline via mobileProfileToggle().
  // Keep JS-only binding for elements that do not have inline handlers.
})();
