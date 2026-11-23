"""
ATLAS agents: Microsoft Rocketbox avatars (MIT; 3ds Max Biped skeleton). Every body gets the same Universal
Animation Library clips, exported at 24 fps, plus a dashboard headshot.

Writes:
  public/models/atlas/agent-rb-*.glb   body + rig + 10 retargeted UAL clips
  public/portraits/rb-*.webp           headshots (see src/components/atlas-office/agentLooks.ts)

Run in Blender:
    exec(open(r"C:\\Users\\Strikeout\\Projects\\atlas\\art\\blender\\build_atlas_agents.py").read())
"""

import os

import bpy

import os
PROJECT = os.environ.get("ATLAS_PROJECT", r"C:\Users\Strikeout\Projects\atlas")
BLENDER_DIR = os.path.join(PROJECT, "art", "blender")
exec(open(os.path.join(BLENDER_DIR, "atlas_retarget.py")).read())  # noqa: S102  (shared helpers)

DOWNLOADS = os.path.join(PROJECT, "Downloaded-Models")
UAL_GLB = os.path.join(DOWNLOADS, "animations", "Universal Animation Library[Standard]", "Unreal-Godot",
                       "UAL1_Standard.glb")
OUT_DIR = os.path.join(PROJECT, "public", "models", "atlas")
SCENE = "ATLAS_Agents"
TEXTURE_SIZE = 1024
CLIPS = ["Idle_Loop", "Walk_Loop", "Jog_Fwd_Loop", "Idle_Talking_Loop", "Sitting_Enter", "Sitting_Idle_Loop",
         "Sitting_Talking_Loop", "Sitting_Exit", "Interact", "Walk_Formal_Loop"]
# Microsoft Rocketbox avatars (MIT licence), downloaded from github.com/microsoft/Microsoft-Rocketbox into
# Downloaded-Models/characters/rocketbox/<name>/{Export/<name>.fbx, Textures/*.tga} (from Assets/Avatars/Professions
# and Assets/Avatars/Adults). key -> folder name.
ROCKETBOX_DIR = os.path.join(DOWNLOADS, "characters", "rocketbox")
ROCKETBOX = {
    "rb-bf1": "Business_Female_01", "rb-bf2": "Business_Female_02", "rb-bf3": "Business_Female_03",
    "rb-bf4": "Business_Female_04", "rb-bm1": "Business_Male_01", "rb-bm2": "Business_Male_02",
    "rb-bm3": "Business_Male_03", "rb-bm4": "Business_Male_04", "rb-bm5": "Business_Male_05",
    "rb-bm6": "Business_Male_06", "rb-bm7": "Business_Male_07",
    # Smart-casual adults (Assets/Avatars/Adults), for companies with more agents than sprite numbers.
    **{f"rb-af{n:02d}": f"Female_Adult_{n:02d}" for n in (1, 2, 5, 7, 9, 11, 14, 15)},
    **{f"rb-am{n:02d}": f"Male_Adult_{n:02d}" for n in (2, 3, 7, 8, 12, 14)},
}
# Headshots for the dashboard: public/portraits/<key>.webp (see src/components/atlas-office/agentLooks.ts).
PORTRAIT_DIR = os.path.join(PROJECT, "public", "portraits")


def fresh_scene():
    for name in (SCENE,):
        old = bpy.data.scenes.get(name)
        if old:
            for obj in list(old.objects):
                bpy.data.objects.remove(obj, do_unlink=True)
            bpy.data.scenes.remove(old)
    scene = bpy.data.scenes.new(SCENE)
    bpy.context.window.scene = scene
    return scene


# The Universal Animation Library is authored at 24 fps. FBX import switches the scene to the file's frame rate
# (e.g. 30 or 60), which made the exported clips play 2.5x / 1.25x too fast (the "twitchy idle").
CLIP_FPS = 24


def export(scene, rig, body, path):
    scene.render.fps = CLIP_FPS
    scene.render.fps_base = 1.0
    for obj in scene.objects:
        obj.select_set(obj in (rig, body))
    bpy.context.view_layer.objects.active = rig
    bpy.ops.export_scene.gltf(
        filepath=path, export_format="GLB", use_selection=True, use_active_scene=True, export_apply=False,
        export_animations=True, export_animation_mode="NLA_TRACKS", export_force_sampling=True,
        export_skins=True, export_morph=False, export_image_format="WEBP", export_image_quality=82, export_yup=True)
    return os.path.getsize(path)


def rocketbox_material(mat, tex_dir):
    """Rebuilds a Rocketbox material from its textures (the FBX points at Microsoft's build machine). Material
    "f014_body" uses f014_body_color/normal.tga; hair, lashes and glasses use *_opacity_color.tga (alpha cut-out)."""
    name = mat.name.split(".")[0]
    color = next((f for f in (f"{name}_color.tga", f"{name}_opacity_color.tga")
                  if os.path.exists(os.path.join(tex_dir, f))), None)
    normal = f"{name}_normal.tga" if os.path.exists(os.path.join(tex_dir, f"{name}_normal.tga")) else None
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

    def image(file, colorspace):
        img = bpy.data.images.load(os.path.join(tex_dir, file), check_existing=False)
        img.colorspace_settings.name = colorspace
        if img.size[0] > TEXTURE_SIZE:
            img.scale(TEXTURE_SIZE, TEXTURE_SIZE)
        img.pack()
        node = nt.nodes.new("ShaderNodeTexImage")
        node.image = img
        return node

    if color:
        tex = image(color, "sRGB")
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
        if "opacity" in color:
            nt.links.new(tex.outputs["Alpha"], bsdf.inputs["Alpha"])
    if normal:
        tex = image(normal, "Non-Color")
        nmap = nt.nodes.new("ShaderNodeNormalMap")
        nt.links.new(tex.outputs["Color"], nmap.inputs["Color"])
        nt.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
    bsdf.inputs["Metallic"].default_value = 0.0
    bsdf.inputs["Roughness"].default_value = 0.55 if name.endswith("_head") else 0.78
    bsdf.inputs["Specular IOR Level"].default_value = 0.35
    return {"material": name, "color": color, "normal": normal}


def import_rocketbox(scene, key, folder):
    """Imports a Rocketbox avatar (3ds Max Biped rig, centimetres, A-pose), applies its scale/rotation so it stands
    in metres facing -Y, joins its meshes and rebuilds the materials from the downloaded textures."""
    base = os.path.join(ROCKETBOX_DIR, folder)
    before_objects, before_actions, before_images = set(bpy.data.objects), set(bpy.data.actions), set(bpy.data.images)
    bpy.ops.import_scene.fbx(filepath=os.path.join(base, "Export", folder + ".fbx"), use_image_search=False)
    for action in [a for a in bpy.data.actions if a not in before_actions]:
        bpy.data.actions.remove(action)  # "Take 001" bind pose
    new = [o for o in bpy.data.objects if o not in before_objects]
    for obj in [o for o in new if o.type == "EMPTY"]:  # "Bip01 Footsteps"
        bpy.data.objects.remove(obj, do_unlink=True)
    rig = next(o for o in bpy.data.objects if o in new and o.type == "ARMATURE")
    meshes = [o for o in bpy.data.objects if o in new and o.type == "MESH"]
    if rig.animation_data:
        rig.animation_data.action = None
    for pb in rig.pose.bones:
        pb.matrix_basis.identity()
    for obj in scene.objects:
        obj.select_set(obj is rig or obj in meshes)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    if len(meshes) > 1:
        for obj in scene.objects:
            obj.select_set(obj in meshes)
        bpy.context.view_layer.objects.active = meshes[0]
        bpy.ops.object.join()
    body = meshes[0]
    tex_dir = os.path.join(base, "Textures")
    materials = [rocketbox_material(slot.material, tex_dir) for slot in body.material_slots if slot.material]
    for img in [i for i in bpy.data.images if i not in before_images and not i.packed_file]:
        bpy.data.images.remove(img)  # the broken references the FBX brought in
    rig.name = f"Agent_{key}_Rig"
    body.name = f"Agent_{key}_Body"
    return rig, body, materials


def render_portrait(scene, rig, key, head_bone):
    """Dashboard headshot (512 px, white background): head and shoulders in the first frame of the idle clip, seen
    at eye level, a little to the character's right, like the existing portraits."""
    from mathutils import Vector

    # Only this character is photographed: earlier ones in a batch build stand around the origin too.
    hidden = [o for o in scene.objects if o is not rig and o.parent is not rig and not o.hide_render]
    for obj in hidden:
        obj.hide_render = True
    track = rig.animation_data.nla_tracks.get("Idle_Loop") if rig.animation_data else None
    rig.animation_data.action = track.strips[0].action if track else None
    scene.frame_set(1)
    bpy.context.view_layer.update()
    head = rig.matrix_world @ rig.pose.bones[head_bone].head
    target = head + Vector((0.0, 0.0, 0.07))
    cam_data = bpy.data.cameras.new("PortraitCam")
    cam_data.lens = 85
    cam = bpy.data.objects.new("PortraitCam", cam_data)
    scene.collection.objects.link(cam)
    cam.location = target + Vector((-0.3, -1.1, 0.03))  # front is -Y; the character's right is -X
    cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
    light_data = bpy.data.lights.new("PortraitKey", "AREA")
    light_data.energy = 45
    light_data.size = 1.0
    light = bpy.data.objects.new("PortraitKey", light_data)
    scene.collection.objects.link(light)
    light.location = target + Vector((-0.9, -1.0, 0.8))
    light.rotation_euler = (target - light.location).to_track_quat("-Z", "Y").to_euler()
    # White backdrop for the camera only; the face is lit by the key light plus a soft grey ambient, so a white
    # world doesn't blow out everything that faces up (shoulders, forehead).
    world = bpy.data.worlds.get("PortraitWorld") or bpy.data.worlds.new("PortraitWorld")
    world.use_nodes = True
    wt = world.node_tree
    wt.nodes.clear()
    backdrop = wt.nodes.new("ShaderNodeBackground")
    backdrop.inputs["Color"].default_value = (1, 1, 1, 1)
    ambient = wt.nodes.new("ShaderNodeBackground")
    ambient.inputs["Color"].default_value = (0.42, 0.42, 0.44, 1)
    path_node = wt.nodes.new("ShaderNodeLightPath")
    mix = wt.nodes.new("ShaderNodeMixShader")
    wt.links.new(path_node.outputs["Is Camera Ray"], mix.inputs["Fac"])
    wt.links.new(ambient.outputs["Background"], mix.inputs[1])
    wt.links.new(backdrop.outputs["Background"], mix.inputs[2])
    wt.links.new(mix.outputs["Shader"], wt.nodes.new("ShaderNodeOutputWorld").inputs["Surface"])
    previous_world, previous_camera = scene.world, scene.camera
    scene.world, scene.camera = world, cam
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = scene.render.resolution_y = 512
    scene.render.film_transparent = False
    scene.view_settings.view_transform = "Standard"
    os.makedirs(PORTRAIT_DIR, exist_ok=True)
    path = os.path.join(PORTRAIT_DIR, f"{key}.webp")
    scene.render.filepath = path
    scene.render.image_settings.file_format = "WEBP"
    scene.render.image_settings.quality = 86
    scene.render.image_settings.color_mode = "RGB"
    bpy.ops.render.render(write_still=True)
    scene.world, scene.camera = previous_world, previous_camera
    for obj in (cam, light):
        bpy.data.objects.remove(obj, do_unlink=True)
    for obj in hidden:
        obj.hide_render = False
    rig.animation_data.action = None
    return os.path.getsize(path)


def build(only=None):
    """Builds every agent, or just the keys in `only` (e.g. ["rb-bf1", "rb-am02"])."""
    scene = fresh_scene()
    scene.render.fps = CLIP_FPS
    report = {}

    def wanted(key):
        return only is None or key in only

    for i, (key, folder) in enumerate(ROCKETBOX.items()):
        if not wanted(key):
            continue
        rig, body, materials = import_rocketbox(scene, key, folder)
        clips = bake_clips(rig, "Bip01 Pelvis", biped_map(), CLIPS, UAL_GLB, suffix=f"_{key}")
        size = export(scene, rig, body, os.path.join(OUT_DIR, f"agent-{key}.glb"))
        portrait = render_portrait(scene, rig, key, "Bip01 Head")
        rig.location.x = (i - 5) * 0.9
        report[key] = {"clips": clips, "glb_bytes": size, "portrait_bytes": portrait, "materials": materials,
                       "tris": sum(len(p.vertices) - 2 for p in body.data.polygons)}
    return report


# Set BUILD_ONLY (a list of keys) before exec'ing this file to rebuild just those agents.
result = build(globals().get("BUILD_ONLY"))
